// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M5 combat relay (PROTOCOL.md §M5). The attacker's client detects the hit; the VICTIM's
// client applies it — for NPCs/creatures the victim's client is that cell's M4 authority
// holder. The server validates shape/plausibility and routes; it NEVER computes damage
// (no game data: armor, resistances and difficulty all apply on the victim).
//
// Routing:
//   CombatHit / CombatSpellHit  -> {playerId} : that player's session only
//                                  {ref,cellKey,epoch} : the cell's authority holder only
//   CombatCast / CombatProjectile -> cell-scoped cosmetic relay, excluding the sender

import { lToJs, type LTable, type LValue, type JsLike } from '../proto/lser';
import { parseObjRef, type ObjRef } from '../proto/ref';
import type { Player, Roster } from './players';
import { INPUT_DRIVING_MS } from './players';
import { cellsVisible, MAX_ABS_COORD } from './movement';
import { TokenBucket } from '../net/ratelimit';
import { metrics } from '../metrics';
import { log } from '../log';

const MAX_ID = 64;
const MAX_CELL_KEY = 128;
const MAX_EFFECTS = 64;

export const COMBAT_EVENTS = new Set(['CombatHit', 'CombatSpellHit', 'CombatCast', 'CombatProjectile']);

// Target union: a player session, or an actor owned by a cell's authority holder.
// epoch is OPTIONAL on actor targets: the attacker is usually a NON-holder, and until it
// has seen an ActorAuthorityInfo/Grant for that cell it has no legal epoch to quote.
// Presence is proven by proximity instead (see resolveOwner); when an epoch IS supplied
// it must be current, which keeps a mid-handoff hit from landing on the wrong simulator.
export type CombatTarget =
  | { kind: 'player'; playerId: number }
  | { kind: 'actor'; ref: ObjRef; cellKey: string; epoch?: number };

export interface CombatCtx {
  worldPeer(): Player | undefined;
  roster: Roster;
  maxHitDamage: number;
  // Current authority holder / epoch for a cell (M4); undefined when dormant.
  holderOf(cellKey: string): number | undefined;
  epochOf(cellKey: string): number | undefined;
  // Plugin gate: false vetoes a player-targeted hit (the pvp builtin owns this).
  allowPlayerHit(attacker: Player, victimId: number, name: string): boolean;
}

function finite(v: LValue | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: LValue | undefined, max = MAX_ID): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;
}

function tbl(v: LValue | undefined): LTable | undefined {
  return v instanceof Map ? v : undefined;
}

function coord(v: LValue | undefined): number | undefined {
  const n = finite(v);
  return n !== undefined && Math.abs(n) <= MAX_ABS_COORD ? n : undefined;
}

function vec3(v: LValue | undefined): { x: number; y: number; z: number } | undefined {
  const t = tbl(v);
  if (!t) return undefined;
  const x = coord(t.get('x'));
  const y = coord(t.get('y'));
  const z = coord(t.get('z'));
  return x !== undefined && y !== undefined && z !== undefined ? { x, y, z } : undefined;
}

// {playerId=u16} | {ref=RefNum, cellKey=, epoch=}. Returns null on malformed input.
function parseTarget(v: LValue | undefined): CombatTarget | null {
  const t = tbl(v);
  if (!t) return null;
  const playerId = finite(t.get('playerId'));
  if (playerId !== undefined) {
    return Number.isInteger(playerId) && playerId >= 1 && playerId <= 0xffff
      ? { kind: 'player', playerId }
      : null;
  }
  const ref = parseObjRef(t);
  const cellKey = str(t.get('cellKey'), MAX_CELL_KEY);
  const rawEpoch = t.get('epoch');
  const epoch = rawEpoch === undefined ? undefined : finite(rawEpoch);
  if (!ref || ref.kind !== 'ref' || !cellKey) return null; // actors are content refs
  if (rawEpoch !== undefined && epoch === undefined) return null; // present but not a number
  return { kind: 'actor', ref, cellKey, ...(epoch !== undefined ? { epoch } : {}) };
}

// Damage/effect magnitudes: finite and within the sanity cap (never balance logic).
function checkedMagnitude(v: LValue | undefined, cap: number): number | undefined {
  const n = finite(v);
  return n !== undefined && Math.abs(n) <= cap ? n : undefined;
}

// THE CAP BOUNDS ONE HIT; THIS BOUNDS THE RATE. maxHitDamage refuses an absurd single blow,
// but nothing stopped a modified client sending a capped hit every frame, which is the same
// kill with more messages. Morrowind's fastest weapons swing a few times a second and spells
// are slower still, so this is far above any real attack sequence and only bites automation.
// ponytail: per-attacker, not per-victim — a focus-fire party is legitimate.
const HITS_PER_SEC = 8;
const HITS_BURST = 20;

// HOW LONG A SWING MAY WAIT FOR ITS SIMULATOR, and how many may wait.
//
// A cell whose sim peer is restarting has no holder, and every attack into it used to be
// discarded — the attacker's client having already cancelled its own damage, so the swing was
// simply gone. Holding them briefly turns a peer restart from "my hits stopped working" into a
// half-second of lag.
//
// BOUNDED IN BOTH DIRECTIONS, because a queue is how you turn a brief outage into a stampede.
// 6s: past that the fight has moved on and landing an old hit is worse than dropping it — the
// target may be dead, fled, or someone else's problem. 64 per cell: enough for a party mid-fight,
// far below what an attacker could use to make the server hold state on their behalf.
const HOLD_MS = 6_000;
const HOLD_MAX_PER_CELL = 64;

export class Combat {
  // Keyed by the Player object, so a disconnected session's bucket is collected with it —
  // a Map keyed by id would grow for the life of the world.
  private readonly hitRate = new WeakMap<Player, TokenBucket>();
  // cellKey -> swings waiting for that cell to get a simulator back.
  private readonly waiting = new Map<string, { player: Player; name: string; body: LTable; at: number }[]>();
  // The body currently being routed. resolveOwner needs it to park a swing, and threading it
  // through every call site would touch four handlers for one case.
  private holding: LTable | null = null;

  constructor(private readonly ctx: CombatCtx) {}

  /** False when this attacker is swinging faster than any real client can. */
  private hitAllowed(player: Player): boolean {
    let b = this.hitRate.get(player);
    if (!b) {
      b = new TokenBucket(HITS_PER_SEC, HITS_BURST);
      this.hitRate.set(player, b);
    }
    return b.take(1);
  }

  // Reasons the ATTACKER should be told about, because they are about the world rather than
  // about them. A cell whose simulator is missing or mid-handoff will swallow every swing until
  // it comes back, and the player has no way to see that: their client already cancelled the
  // local damage, so the attack simply does nothing. The rest are deliberately NOT reported —
  // 'invalid shape' and 'malformed body' are client bugs a player cannot act on, and telling a
  // cheat client which check it tripped ('hit rate above any real client') only helps it tune.
  private static readonly TELL_ATTACKER = new Set([
    'cell has no authority holder',
    'authority holder gone',
    'stale epoch',
  ]);

  /** Park a swing until its cell has a simulator again. Called instead of dropping it. */
  private hold(player: Player, name: string, cellKey: string): void {
    const body = this.holding;
    if (!body) { this.drop(player, name, 'cell has no authority holder'); return; }
    const q = this.waiting.get(cellKey) ?? [];
    if (q.length >= HOLD_MAX_PER_CELL) {
      // Full. Drop the OLDEST rather than refusing the newest: if a cell is this busy the recent
      // swings are the ones still worth landing.
      const stale = q.shift();
      if (stale) this.drop(stale.player, stale.name, 'cell has no authority holder');
    }
    q.push({ player, name, body, at: Date.now() });
    this.waiting.set(cellKey, q);
    metrics.combatHeld.inc({ outcome: 'held' });
    log('info', 'combat.held', { from: player.name, name, cellKey, waiting: q.length });
  }

  /**
   * A cell just got a simulator. Deliver everything that was waiting on it.
   * Wired from worldstate's authority grant.
   */
  flushCell(cellKey: string): void {
    const q = this.waiting.get(cellKey);
    if (!q || q.length === 0) return;
    this.waiting.delete(cellKey);
    const now = Date.now();
    for (const held of q) {
      if (now - held.at > HOLD_MS) {
        // Too old to land honestly — the fight has moved on.
        metrics.combatHeld.inc({ outcome: 'expired' });
        this.drop(held.player, held.name, 'cell has no authority holder');
        continue;
      }
      if (!held.player.inWorld) { metrics.combatHeld.inc({ outcome: 'expired' }); continue; }
      metrics.combatHeld.inc({ outcome: 'delivered' });
      // Re-run the ordinary path: the cell has a holder now, so it routes normally. Re-parsed
      // rather than cached-through, so every guard (proximity, epoch, damage cap) applies to
      // the delivery exactly as it would have to the original.
      this.handleEvent(held.player, held.name, held.body as unknown as LValue);
    }
  }

  /** Expire anything that has been waiting too long, whether or not a grant ever arrives. */
  sweepHeld(): void {
    const now = Date.now();
    for (const [cellKey, q] of this.waiting) {
      const live = q.filter((h) => {
        if (now - h.at <= HOLD_MS) return true;
        metrics.combatHeld.inc({ outcome: 'expired' });
        this.drop(h.player, h.name, 'cell has no authority holder');
        return false;
      });
      if (live.length === 0) this.waiting.delete(cellKey);
      else this.waiting.set(cellKey, live);
    }
  }

  private drop(player: Player, name: string, why: string): void {
    log('warn', 'combat.dropped', { from: player.name, name, why });
    // COUNT IT. The attacker's client cancelled its own damage before sending, so every drop
    // here is an attack the player made that did nothing at all and was told nothing about.
    // A rising rate on any reason is the machine-readable form of "my hits are not landing".
    metrics.combatDropped.inc({ reason: why });
    if (Combat.TELL_ATTACKER.has(why)) {
      // The client throttles this — a player swinging at a dormant cell generates one of these
      // per swing, and the point is to explain the situation once, not to narrate every miss.
      player.peer.sendEvent('CombatRefused', { reason: why });
    }
  }

  // Resolves the union to the single session that owns damage application, or null when
  // the target is unknown / the actor's cell authority does not match the sender's claim.
  private resolveOwner(attacker: Player, target: CombatTarget, name: string): Player | null {
    if (target.kind === 'player') {
      const victim = this.ctx.roster.get(target.playerId);
      if (!victim || !victim.inWorld) {
        this.drop(attacker, name, 'unknown target player');
        return null;
      }
      // THE ACTOR PATH CHECKED PROXIMITY AND THIS ONE DID NOT, so a player could be hit from
      // anywhere in the world. Same rule for both: you must be near enough to see the target.
      if (!cellsVisible(attacker.cellKey, victim.cellKey)) {
        this.drop(attacker, name, 'attacker not near the target player');
        return null;
      }
      if (!this.ctx.allowPlayerHit(attacker, victim.id, name)) return null; // pvp plugin veto
      // Phase 4B: while the victim is DRIVING the input tier, their own stat assertions are
      // ignored (4A one-writer rule) -- so damage applied on their client would vanish. The
      // world peer applies the hit to the victim's AVATAR instead, and the damage travels
      // back through the peer's bar reports. An input-less victim keeps the old delivery.
      if (victim.lastInputAt !== undefined && Date.now() - victim.lastInputAt <= INPUT_DRIVING_MS) {
        const worldPeer = this.ctx.worldPeer();
        if (worldPeer) return worldPeer;
      }
      return victim;
    }
    // Actor target: the owner is whoever currently simulates the cell. Unlike the Actor*
    // family (authored BY the holder, where the epoch is the race-killer), the attacker
    // here is typically a non-holder, so presence is proven by proximity and the epoch is
    // only checked when supplied.
    if (!cellsVisible(attacker.cellKey, target.cellKey)) {
      this.drop(attacker, name, 'attacker not near the target cell');
      return null;
    }
    const holderId = this.ctx.holderOf(target.cellKey);
    if (holderId === undefined) {
      // NOT A DROP: the cell has no simulator AT THIS MOMENT — the peer is restarting, or has
      // not picked this cell up yet. The attacker's client already cancelled its own damage, so
      // discarding here costs them the whole swing. Hold it and deliver when the cell is
      // granted; `flushCell` does that, and anything still waiting after HOLD_MS is dropped for
      // real (with the same metric and log, so a peer that never comes back still shows up).
      this.hold(attacker, name, target.cellKey);
      return null;
    }
    if (target.epoch !== undefined && this.ctx.epochOf(target.cellKey) !== target.epoch) {
      this.drop(attacker, name, 'stale epoch');
      return null;
    }
    const holder = this.ctx.roster.get(holderId);
    if (!holder) {
      this.drop(attacker, name, 'authority holder gone');
      return null;
    }
    return holder;
  }

  // Returns true when `name` belongs to the combat family (handled or dropped).
  handleEvent(player: Player, name: string, value: LValue | undefined): boolean {
    if (!COMBAT_EVENTS.has(name)) return false;
    const body = tbl(value);
    if (!body) {
      this.drop(player, name, 'malformed body');
      return true;
    }
    this.holding = body; // see `holding` — resolveOwner may need to park this swing
    switch (name) {
      case 'CombatHit': this.hit(player, body); break;
      case 'CombatSpellHit': this.spellHit(player, body); break;
      case 'CombatCast': this.cast(player, body); break;
      case 'CombatProjectile': this.projectile(player, body); break;
    }
    return true;
  }

  private hit(player: Player, body: LTable): void {
    if (!this.hitAllowed(player)) {
      this.drop(player, 'CombatHit', 'hit rate above any real client');
      return;
    }
    const target = parseTarget(body.get('target'));
    const damage = tbl(body.get('damage'));
    const strength = finite(body.get('strength'));
    const sourceType = str(body.get('sourceType'));
    const successful = body.get('successful');
    if (!target || !damage || strength === undefined || !sourceType || typeof successful !== 'boolean') {
      this.drop(player, 'CombatHit', 'invalid shape');
      return;
    }
    const cap = this.ctx.maxHitDamage;
    // AT LEAST ONE damage channel — NOT `health` specifically.
    //
    // The engine builds this table with EITHER health OR fatigue and never both
    // (mwlua/luamanagerimp.cpp onHit: `if (isHealth) damageTable["health"] = damage; else
    // damageTable["fatigue"] = damage;`), and in Morrowind an UNARMED attack damages
    // FATIGUE. Demanding health therefore dropped every hand-to-hand swing in the game:
    // a character with no weapon equipped could not land a single blow.
    //
    // It fails silently and total. puppet.lua's onHitIntercept has already returned false
    // and cancelled the local damage chain by the time the server sees this, so a dropped
    // hit is not a lost message but a lost SWING — no damage, no miss, no sound, no blood.
    // The player swings through the target and the game says nothing at all, which is
    // exactly how it was reported: "I cannot attack anything".
    let channels = 0;
    for (const key of ['health', 'fatigue', 'magicka'] as const) {
      const raw = damage.get(key);
      if (raw === undefined) continue;
      if (checkedMagnitude(raw, cap) === undefined) {
        this.drop(player, 'CombatHit', `damage.${key} over cap`);
        return;
      }
      channels++;
    }
    if (channels === 0) {
      this.drop(player, 'CombatHit', 'damage has no health/fatigue/magicka channel');
      return;
    }
    // Optional ids/position, validated when present.
    for (const key of ['weaponId', 'ammoId'] as const) {
      if (body.get(key) !== undefined && !str(body.get(key))) {
        this.drop(player, 'CombatHit', `${key} invalid`);
        return;
      }
    }
    if (body.get('hitPos') !== undefined && !vec3(body.get('hitPos'))) {
      this.drop(player, 'CombatHit', 'hitPos out of bounds');
      return;
    }
    const owner = this.resolveOwner(player, target, 'CombatHit');
    if (!owner) return;
    owner.peer.sendEvent('CombatHit', { ...(lToJs(body) as Record<string, JsLike>), attackerId: player.id });
  }

  private spellHit(player: Player, body: LTable): void {
    if (!this.hitAllowed(player)) {
      this.drop(player, 'CombatSpellHit', 'hit rate above any real client');
      return;
    }
    const target = parseTarget(body.get('target'));
    const spellId = str(body.get('spellId'));
    const effects = tbl(body.get('effects'));
    const casterId = finite(body.get('casterId'));
    if (!target || !spellId || !effects || casterId === undefined || effects.size > MAX_EFFECTS) {
      this.drop(player, 'CombatSpellHit', 'invalid shape');
      return;
    }
    const cap = this.ctx.maxHitDamage;
    for (const [, entry] of effects) {
      const e = tbl(entry);
      const id = e ? str(e.get('id')) : undefined;
      const magnitude = e ? checkedMagnitude(e.get('magnitude'), cap) : undefined;
      const duration = e ? checkedMagnitude(e.get('duration'), cap) : undefined;
      if (!id || magnitude === undefined || duration === undefined) {
        this.drop(player, 'CombatSpellHit', 'invalid effect entry or over cap');
        return;
      }
    }
    const owner = this.resolveOwner(player, target, 'CombatSpellHit');
    if (!owner) return;
    owner.peer.sendEvent('CombatSpellHit', { ...(lToJs(body) as Record<string, JsLike>), attackerId: player.id });
  }

  // Cosmetic mirrors: relayed to the sender's cell, excluding the sender (who already
  // played the animation locally). No target ownership involved.
  private relayCosmetic(player: Player, name: string, body: LTable): void {
    const cellKey = player.cellKey;
    if (!cellKey) return;
    const out = { ...(lToJs(body) as Record<string, JsLike>), fromId: player.id };
    for (const p of this.ctx.roster.inWorld()) {
      if (p.id !== player.id && cellsVisible(p.cellKey, cellKey)) p.peer.sendEvent(name, out);
    }
  }

  private cast(player: Player, body: LTable): void {
    const spellId = str(body.get('spellId'));
    const casterId = finite(body.get('casterId'));
    const kind = body.get('kind');
    if (!spellId || casterId === undefined || (kind !== 'spell' && kind !== 'enchant' && kind !== 'potion')) {
      this.drop(player, 'CombatCast', 'invalid shape');
      return;
    }
    // target is optional here (self-cast / area) and purely informational.
    if (body.get('target') !== undefined && !parseTarget(body.get('target'))) {
      this.drop(player, 'CombatCast', 'invalid target');
      return;
    }
    this.relayCosmetic(player, 'CombatCast', body);
  }

  private projectile(player: Player, body: LTable): void {
    const kind = body.get('kind');
    const from = vec3(body.get('from'));
    const dir = vec3(body.get('dir'));
    const speed = finite(body.get('speed'));
    const casterId = finite(body.get('casterId'));
    if (
      (kind !== 'arrow' && kind !== 'bolt' && kind !== 'thrown' && kind !== 'magic') ||
      !from || !dir || speed === undefined || casterId === undefined
    ) {
      this.drop(player, 'CombatProjectile', 'invalid shape');
      return;
    }
    for (const key of ['recordId', 'spellId'] as const) {
      if (body.get(key) !== undefined && !str(body.get(key))) {
        this.drop(player, 'CombatProjectile', `${key} invalid`);
        return;
      }
    }
    this.relayCosmetic(player, 'CombatProjectile', body);
  }
}
