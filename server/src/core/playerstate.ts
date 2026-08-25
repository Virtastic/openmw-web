// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M2 player-state event family (PROTOCOL.md §M2): validate, store into the PlayerStore
// canonical doc, and relay per-message policy (appearance/equipment -> ALL in-world with
// id, sender included, mirroring PlayerCellChange; dynamic stats -> VISIBLE only;
// attributes/skills/level/spellbook/inventory -> store only; death -> plugin hooks).

import type { LValue, LTable, JsLike } from '../proto/lser';
import type { Player, Roster } from './players';
import type { PlayerStore, PlayerAppearanceDoc, DynamicStatDoc } from '../persist/playerstore';
import { cellsVisible } from './movement';
import { log } from '../log';
import { metrics } from '../metrics';

const MAX_RECORD_ID = 64;
const MAX_INVENTORY = 512;
const MAX_COUNT = 10000;
const MAX_SPELLS = 1024;
const MAX_STAT_ENTRIES = 64;
const MAX_STAT_KEY = 32;
export const MAX_EQUIPMENT_SLOT = 20;

export interface StateCtx {
  roster: Roster;
  store: PlayerStore;
  onPlayerDeath(player: Player): void;
  // Chargen is the only place a character is really named, and the name arrives here in the
  // appearance. Without this the slot keeps its placeholder forever and the character screen
  // shows "Adventurer" next to a character the player named something else.
  onCharacterNamed?(player: Player, name: string): void;
  // Anti-cheat telemetry, same contract movement uses: the client authors its own character,
  // so this is the SIGNAL moderation acts on, never a rejection.
  noteAnomaly?(accountKey: string, kind: string): void;
}

function tbl(v: LValue | undefined): LTable | undefined {
  return v instanceof Map ? v : undefined;
}

function recordId(v: LValue | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_RECORD_ID ? v : undefined;
}

function finite(v: LValue | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function relayAll(roster: Roster, name: string, body: JsLike): void {
  for (const p of roster.inWorld()) p.peer.sendEvent(name, body);
}

// ------------------------------------------------------- per-message handlers

function handleAppearance(ctx: StateCtx, player: Player, body: LTable): boolean {
  const appearance: PlayerAppearanceDoc = {
    race: recordId(body.get('race')) ?? '',
    head: recordId(body.get('head')) ?? '',
    hair: recordId(body.get('hair')) ?? '',
    class: recordId(body.get('class')) ?? '',
    name: recordId(body.get('name')) ?? '',
    isMale: body.get('isMale') === true,
  };
  // hair is OPTIONAL: bald/hairless heads are legal in the game data, and demanding it would
  // permanently reject those characters' appearance. The rest identify the character and are
  // required. Name the offending field when rejecting — a silent drop here is expensive:
  // doc.appearance stays unset, which withholds playerRecord on every join (connection.ts),
  // so inventory and position are never restored and the live client overwrites the doc.
  // A boot path that sent name="" cost a player their quest items exactly this way.
  const missing = (['race', 'head', 'class', 'name'] as const).filter((k) => !appearance[k]);
  if (missing.length > 0) {
    log('warn', 'state.appearance_incomplete', { from: player.name, missing: missing.join(',') });
    return false;
  }
  ctx.store.update(player.charId, (doc) => (doc.appearance = appearance));
  ctx.onCharacterNamed?.(player, appearance.name);
  relayAll(ctx.roster, 'PlayerAppearance', { id: player.id, ...appearance });
  return true;
}

function parseEquipment(body: LTable): Record<number, string> | undefined {
  const slots = tbl(body.get('slots'));
  if (!slots || slots.size > MAX_EQUIPMENT_SLOT + 1) return undefined;
  const out: Record<number, string> = {};
  for (const [k, v] of slots) {
    const id = recordId(v);
    if (typeof k !== 'number' || !Number.isInteger(k) || k < 0 || k > MAX_EQUIPMENT_SLOT || !id) return undefined;
    out[k] = id;
  }
  return out;
}

function handleEquipment(ctx: StateCtx, player: Player, body: LTable): boolean {
  const slots = parseEquipment(body);
  if (!slots) return false;
  ctx.store.update(player.charId, (doc) => (doc.equipment = slots), 'debounced');
  relayAll(ctx.roster, 'PlayerEquipment', { id: player.id, slots: equipmentToL(slots) });
  return true;
}

// Slot keys must go over the wire as Lua NUMBER keys, not strings.
export function equipmentToL(slots: Record<number, string>): LTable {
  const t: LTable = new Map();
  for (const [k, v] of Object.entries(slots)) t.set(Number(k), v);
  return t;
}

function parseDynamicStat(v: LValue | undefined): DynamicStatDoc | undefined {
  const t = tbl(v);
  const c = t ? finite(t.get('c')) : undefined;
  const b = t ? finite(t.get('b')) : undefined;
  return c !== undefined && b !== undefined ? { c, b } : undefined;
}

function handleStatsDynamic(ctx: StateCtx, player: Player, body: LTable): boolean {
  const hp = parseDynamicStat(body.get('hp'));
  const mp = parseDynamicStat(body.get('mp'));
  const ft = parseDynamicStat(body.get('ft'));
  if (!hp || !mp || !ft) return false;
  // DEATH IS A FLUSH POINT. Everything else here rides the sweep, but hp reaching 0 must hit
  // the disk immediately: the client sends the death edge instantly, and a player who dies
  // and closes the tab in the same second would otherwise rejoin alive — a progress bug and
  // an exploit at once. Being alive is still cheap (sweep), so this costs a write per death,
  // not per tick.
  const died = hp.c <= 0;
  ctx.store.update(player.charId, (doc) => {
    doc.stats = { ...doc.stats, dynamic: { hp, mp, ft } };
  }, died ? 'now' : 'sweep');
  const msg = { id: player.id, hp, mp, ft };
  for (const p of ctx.roster.inWorld()) {
    if (cellsVisible(p.cellKey, player.cellKey)) p.peer.sendEvent('PlayerStatsDynamic', msg);
  }
  return true;
}

// Flat string->finite-number map (attributes, skills).
function parseNumberMap(body: LTable): Record<string, number> | undefined {
  if (body.size > MAX_STAT_ENTRIES) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of body) {
    const n = finite(v);
    if (typeof k !== 'string' || k.length === 0 || k.length > MAX_STAT_KEY || n === undefined) return undefined;
    out[k] = n;
  }
  return out;
}

function handleNumberMap(ctx: StateCtx, player: Player, body: LTable, field: 'attributes' | 'skills'): boolean {
  const map = parseNumberMap(body);
  if (!map) return false;
  ctx.store.update(player.charId, (doc) => {
    doc.stats = { ...doc.stats, [field]: map };
  });
  return true;
}

function handleLevel(ctx: StateCtx, player: Player, body: LTable): boolean {
  const level = finite(body.get('level'));
  if (level === undefined || !Number.isInteger(level) || level < 1 || level > 255) return false;
  // A level moves by ONE at a time in Morrowind. Several at once is not a fast player, it is
  // a declaration — same absurd-only bar as the movement envelope, same non-rejecting answer.
  const had = ctx.store.getCached(player.charId)?.stats?.level;
  if (had !== undefined && level - had >= LEVEL_JUMP_LIMIT) {
    // REFUSED, not merely counted. A level moves by one at a time in Morrowind: there is no
    // legitimate path that produces a jump this size, so unlike the inventory bar below there
    // is no false positive to trade against. Dropping the message leaves the server's own
    // level standing, and the client's next declaration is measured against that.
    noteGain(ctx, player, 'level_jump', { from: had, to: level });
    return false;
  }
  // Level-up is a specced flush point.
  ctx.store.update(player.charId, (doc) => (doc.stats = { ...doc.stats, level }), 'now');
  return true;
}

function parseIdList(v: LValue | undefined): string[] | undefined {
  const t = tbl(v);
  if (!t) return v === undefined ? [] : undefined; // omitted list = empty (nil-field convention)
  const out: string[] = [];
  for (const [, item] of t) {
    const id = recordId(item);
    if (!id) return undefined;
    out.push(id);
  }
  return out;
}

function handleSpellbook(ctx: StateCtx, player: Player, body: LTable): boolean {
  const add = parseIdList(body.get('add'));
  const remove = parseIdList(body.get('remove'));
  if (add === undefined || remove === undefined) return false;
  ctx.store.update(player.charId, (doc) => {
    const spells = new Set(doc.spells ?? []);
    for (const id of add) spells.add(id);
    for (const id of remove) spells.delete(id);
    doc.spells = [...spells].slice(0, MAX_SPELLS);
  });
  return true;
}

// Deliberately absurd-only thresholds, exactly like the movement envelope: Morrowind has
// legitimate bulk (a merchant's stock bought out, 400 arrows, a hoard moved in one go), and a
// false positive on a real player is worse than a cheat that has to stay under the bar.
// Containers ARE server-transactional (worldstate.containerOp conserves take/put), but
// PlayerInventory bypasses them entirely and overwrites the doc, so this is the only place a
// declared hoard is visible at all.
// ponytail: heuristic, not a ledger. A real ledger needs purchase/barter to be server-side
// first, otherwise every shopping trip is a false positive.
// These now REJECT rather than count, so they are set where a false positive is implausible
// rather than where a cheat is obvious — a refused declaration costs a real player their
// inventory sync, which is worse than a cheat that has to stay under the bar. Barter is
// client-side, so a merchant bought out in one go is the shape most likely to trip the breadth
// rule; both were raised when they stopped being advisory. metrics.implausibleGains still
// records every trip, so what real players actually hit is measurable before tightening.
// A single stack is already hard-capped at MAX_COUNT (10000) by the shape check above, so this
// rule only catches a near-max jump appearing in one step; the breadth rule below is the one
// doing real work. Kept under MAX_COUNT deliberately — a threshold above it can never fire.
const IMPLAUSIBLE_STACK = 9000;   // one item id gaining this much in a single declaration
const IMPLAUSIBLE_DISTINCT = 250; // this many NEW item ids appearing at once
// Morrowind levels one at a time; five at once is a declaration, not a fast player.
const LEVEL_JUMP_LIMIT = 5;

function noteGain(ctx: StateCtx, player: Player, kind: string, detail: Record<string, unknown>): void {
  metrics.implausibleGains.inc({ kind });
  ctx.noteAnomaly?.(player.accountKey, kind);
  log('warn', 'state.implausible_gain', { kind, player: player.name, account: player.accountKey, ...detail });
}

function handleInventory(ctx: StateCtx, player: Player, body: LTable): boolean {
  const items = tbl(body.get('items'));
  if (!items || items.size > MAX_INVENTORY) return false;
  const out: { id: string; n: number }[] = [];
  for (const [, entry] of items) {
    const t = tbl(entry);
    const id = t ? recordId(t.get('id')) : undefined;
    const n = t ? finite(t.get('n')) : undefined;
    if (!id || n === undefined || !Number.isInteger(n) || n < 1 || n > MAX_COUNT) return false;
    out.push({ id, n });
  }
  // Compare against what this character last declared, before overwriting it.
  const prev = ctx.store.getCached(player.charId)?.inventory ?? [];
  const before = new Map(prev.map((i) => [i.id, i.n]));
  let newIds = 0;
  for (const { id, n } of out) {
    const had = before.get(id);
    if (had === undefined) newIds++;
    if (n - (had ?? 0) >= IMPLAUSIBLE_STACK) {
      // REFUSED now, not merely counted. The declaration is dropped whole and the server's
      // copy stands, so the client's next pass is measured against what the server believes
      // rather than against the hoard it just claimed.
      noteGain(ctx, player, 'inventory_stack', { item: id, from: had ?? 0, to: n });
      return false;
    }
  }
  if (newIds >= IMPLAUSIBLE_DISTINCT) {
    noteGain(ctx, player, 'inventory_breadth', { newItems: newIds, total: out.length });
    return false;
  }
  ctx.store.update(player.charId, (doc) => (doc.inventory = out));
  // The snapshot now accounts for everything credited since the last one, so the credit is
  // spent. Clearing here (rather than expiring on a timer) is what keeps the ledger from
  // double-counting: credit and snapshot are the same items seen twice.
  player.pendingAcquired?.clear();
  return true;
}

// A single acquisition, reported the moment it happens. Deliberately additive and unvalidated
// against any "could you have got this?" rule: it is not a claim of ownership, it is a claim of
// TIMING — "the snapshot you have is stale by this much". Over-reporting therefore buys a
// cheater nothing that declaring a fat PlayerInventory would not already buy them, and that path
// is guarded separately (IMPLAUSIBLE_STACK / IMPLAUSIBLE_DISTINCT above).
function handleItemAcquired(ctx: StateCtx, player: Player, body: LTable): boolean {
  const id = recordId(body.get('id'));
  const n = finite(body.get('n'));
  if (!id || n === undefined || !Number.isInteger(n) || n < 1 || n > MAX_COUNT) return false;
  const led = (player.pendingAcquired ??= new Map<string, number>());
  // Bounded by the same breadth limit the snapshot uses, so a client cannot grow this map
  // without bound between snapshots.
  if (!led.has(id) && led.size >= MAX_INVENTORY) return false;
  led.set(id, Math.min(MAX_COUNT, (led.get(id) ?? 0) + n));
  return true;
}

// ------------------------------------------------------------------- router

// Returns true when `name` belongs to the M2 state family (whether or not the body
// validated — invalid bodies are dropped with a warn, never relayed).
const HANDLERS: Record<string, (ctx: StateCtx, player: Player, body: LTable) => boolean> = {
  PlayerAppearance: handleAppearance,
  PlayerEquipment: handleEquipment,
  PlayerStatsDynamic: handleStatsDynamic,
  PlayerAttributes: (c, p, b) => handleNumberMap(c, p, b, 'attributes'),
  PlayerSkills: (c, p, b) => handleNumberMap(c, p, b, 'skills'),
  PlayerLevel: handleLevel,
  PlayerSpellbook: handleSpellbook,
  PlayerInventory: handleInventory,
  PlayerItemAcquired: handleItemAcquired,
};

export function handleStateEvent(ctx: StateCtx, player: Player, name: string, value: LValue | undefined): boolean {
  if (name === 'PlayerDeath') {
    ctx.onPlayerDeath(player); // body is {} and carries nothing
    return true;
  }
  const handler = HANDLERS[name];
  if (!handler) return false;
  const body = tbl(value);
  if (!body || !handler(ctx, player, body)) log('warn', 'state.invalid_body', { from: player.name, name });
  return true;
}

// Late-joiner state sync (M2 design, documented in README/report):
// on world join the server (1) sends the JOINER the cached appearance+equipment of every
// other in-world player, and (2) broadcasts the joiner's STORED appearance+equipment to
// the OTHERS (the joiner already has its own via SessionWelcome.playerRecord). Fresh
// players have no doc; their state reaches everyone via their own post-chargen
// PlayerAppearance/PlayerEquipment broadcasts.
export function syncStateOnJoin(ctx: StateCtx, joiner: Player): void {
  for (const other of ctx.roster.inWorld()) {
    if (other.id === joiner.id) continue;
    const doc = ctx.store.getCached(other.charId);
    if (doc?.appearance) joiner.peer.sendEvent('PlayerAppearance', { id: other.id, ...doc.appearance });
    if (doc?.equipment) joiner.peer.sendEvent('PlayerEquipment', { id: other.id, slots: equipmentToL(doc.equipment) });
  }
  const own = ctx.store.getCached(joiner.charId);
  if (!own) return;
  for (const other of ctx.roster.inWorld()) {
    if (other.id === joiner.id) continue;
    if (own.appearance) other.peer.sendEvent('PlayerAppearance', { id: joiner.id, ...own.appearance });
    if (own.equipment) other.peer.sendEvent('PlayerEquipment', { id: joiner.id, slots: equipmentToL(own.equipment) });
  }
}
