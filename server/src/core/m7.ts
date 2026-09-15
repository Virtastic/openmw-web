// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M7 world-state family (PROTOCOL.md §M7): the server-owned clock, per-region weather
// authority, server-issued custom records, operator cell resets, shared map exploration
// and server-pushed GUI. This module is the router + the two pieces that have nowhere
// better to live (records and the cell-reset scheduler); the clock, the weather
// authority and the GUI queue are their own modules.
//
// Everything inbound is validated and warn+dropped — a malformed frame costs the sender
// its message budget, never the shared world.

import type { LTable, LValue, JsLike } from '../proto/lser';
import { lToJs } from '../proto/lser';
import type { Player, Roster } from './players';
import { WorldClock } from './worldtime';
import { WeatherRegions } from './weather';
import type { CellStore, CellDoc } from '../persist/cellstore';
import type { PlayerStore } from '../persist/playerstore';
import { RecordStore, RECORD_KINDS, type RecordKind, type CustomRecord } from '../persist/recordstore';
import { log } from '../log';
import { metrics } from '../metrics';

const MAX_CELL_KEY = 128;
// A DoS bound, not a gameplay bound. 1024 is inside what a thorough player explores across
// Vvardenfell and Solstheim, and exceeding it dropped the whole map sync while reporting
// 'invalid shape' -- which is not what happened and sends anyone debugging it the wrong way.
const MAX_MAP_CELLS = 8192;
const MAX_EXPLORED = 1024; // exterior keys kept on a character doc (backlog 260)
const MAX_RECORD_FIELDS = 128;
// A DEPLOYMENT-WIDE CEILING ON CUSTOM RECORDS (the store is shared by every world since backlog
// 315), for the same reason regions have one and for a worse consequence. Every RecordCreate is appended to the store, INSERTed into SQLite, and -- this is
// the part that compounds -- replayed in full to every player who joins from then on, because a
// peer must be able to resolve an id before an item bearing it arrives. Nothing bounded the
// count: a client spending its ordinary message budget adds records for as long as it likes, and
// each one makes every future join larger, permanently. Fifty thousand across a deployment's
// worlds is far past any honest campaign of enchanting and alchemy (~400 frames of 128 on a
// join) and still below the point where a join becomes a problem.
const MAX_CUSTOM_RECORDS = 50_000;
// THE JOIN REPLAY MUST BE CHUNKED, and this is a correctness bound, not a politeness one. LSER
// refuses to decode a value with more than 65,536 nodes, and a record costs up to ~263 of them
// (the row, three keys and their values, and two per data field up to MAX_RECORD_FIELDS). Sent
// as one frame, a world with a few hundred enchanted items produced a RecordsSync the client
// could not decode AT ALL -- `lser: more than 65536 nodes` -- so the world stopped being
// joinable, permanently, and nothing about the failure names records.
//
// 128 x 263 is ~33k nodes, half the ceiling with every field used. Chunking is safe without any
// client change because MP_RecordsSync MERGES: world.lua iterates the batch and applies each
// record, and the post-creation path already sends a one-record RecordsSync, so a partial batch
// is the shape it has always handled.
const RECORDS_PER_SYNC = 128;
const RESET_TICK_MS = 1_000;
// RECORD BODIES ARE CLIENT-AUTHORED AND REPLAYED TO THE PEER, whose avatar then fights with them.
// Nothing bounded the numbers: chopMaxDamage=9999 or Fortify Health 10000 for 10^6 s were stored
// and handed to everyone. #360: capped at the VANILLA maxima now, not 4x -- the spellmaker and
// enchanter sliders stop at magnitude 100 per effect and duration 1440 s with at most eight
// effects, the strongest retail weapons (Daedric claymore, Chrysamere) top out near 50 per swing
// type; armor rating, enchant charge, speed and reach get the same treatment. A record over the
// line is a cheat, not a mod.
const MAX_EFFECT_MAGNITUDE = 100;
const MAX_EFFECT_DURATION = 1440;
const MAX_EFFECTS = 8;
const MAX_WEAPON_DAMAGE = 4 * 50;
const MAX_ARMOR = 200;
const MAX_CHARGE = 400;
const MAX_SPEED = 2;
const MAX_REACH = 2;
const DAMAGE_FIELDS = ['chopMinDamage', 'chopMaxDamage', 'slashMinDamage', 'slashMaxDamage', 'thrustMinDamage', 'thrustMaxDamage'];
// #360: a spell's cost is client-declared and the engine bills magicka from it. The vanilla
// formula (spellmaker) is 0.1 x baseCost x avg(magnitude) x (1 + duration) per effect, and
// the server does not know an effect's baseCost (the cheapest vanilla ones are a few tenths),
// so the floor is Σ(magnitudeMax x max(duration,1)) / 100: below it the spell is free, above
// it the engine's own figure decides. Clamped to >= 1. An autocalc spell carries no cost.
function minSpellCost(effects: Record<string, unknown>[]): number {
  let sum = 0;
  for (const e of effects) {
    const mag = typeof e['magnitudeMax'] === 'number' ? e['magnitudeMax'] : 0;
    const dur = typeof e['duration'] === 'number' ? Math.max(1, e['duration']) : 1;
    sum += (mag * dur) / 100;
  }
  return Math.max(1, Math.floor(sum));
}
function recordWithinCaps(data: unknown, kind?: string): boolean {
  if (!data || typeof data !== 'object') return true;
  const d = data as Record<string, unknown>;
  const over = (v: unknown, cap: number) => typeof v === 'number' && (v > cap || v < 0);
  if (DAMAGE_FIELDS.some((f) => over(d[f], MAX_WEAPON_DAMAGE))) return false;
  if (over(d['baseArmor'], MAX_ARMOR) || over(d['charge'], MAX_CHARGE) || over(d['speed'], MAX_SPEED) || over(d['reach'], MAX_REACH)) return false;
  const effects = Array.isArray(d['effects']) ? d['effects'] as Record<string, unknown>[] : [];
  if (effects.length > MAX_EFFECTS) return false;
  if (effects.some((e) => e && typeof e === 'object'
    && (over(e['magnitudeMin'], MAX_EFFECT_MAGNITUDE) || over(e['magnitudeMax'], MAX_EFFECT_MAGNITUDE)
      || over(e['duration'], MAX_EFFECT_DURATION)))) return false;
  // Only a SPELL bills its cost from the record (an enchantment spends charge, a potion nothing).
  if (kind === 'spell' && d['isAutocalc'] !== true && effects.length > 0 && typeof d['cost'] === 'number' && d['cost'] < minSpellCost(effects)) return false;
  return true;
}

export const M7_EVENTS = new Set([
  'WorldTimeRequest',
  'WorldRegionChange',
  'WorldWeather',
  'RecordCreate',
  'WorldMapExplored',
]);

export interface M7Ctx {
  roster: Roster;
  cells: CellStore;
  records: RecordStore;
  // M6 sharing policy, asked per relay (the `sharing` plugin answers from [sharing]).
  isMapShared(): boolean;
  // Backlog 260: where exploration persists. The explorer's own doc always; the campaign
  // owner's too when the map is shared, so a guest's discoveries outlive their visit.
  players?: PlayerStore;
  ownerCharId?(): string | undefined;
  // Phase 3.7: set after construction (WorldState and WorldM7 are mutually referential).
  // Used to push the restored cell truth to occupants right after a reset.
  world?: { sendCellSnapshot(cellKey: string, doc: CellDoc): void };
  // Phase 2.5 time-skip policy. Absent = unrestricted (M7 behaviour).
  maySkipTime?(player: Player): { may: boolean; why: string };
}

function str(v: LValue | undefined, max: number): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;
}

export class WorldM7 {
  readonly clock: WorldClock;
  readonly weather: WeatherRegions;
  private recordQueue: Promise<void> = Promise.resolve();
  private recordFloodLogged = false; // said once, not once per refusal
  private resetTimer?: NodeJS.Timeout;
  // The sweep awaits each reset and runs on a 1 s interval, but lastResetMs is only written
  // AFTER the awaited wipe -- so a reset slower than a tick let the next tick see the old
  // stamp and reset the same cell again: two wipes, two WorldCellReset broadcasts, two
  // snapshots. One flag makes a tick that arrives mid-sweep a no-op.
  private sweeping = false;

  constructor(private readonly ctx: M7Ctx) {
    const m7 = ctx.cells.worldM7();
    this.clock = new WorldClock({
      state: m7.time,
      save: () => ctx.cells.saveShared(),
      broadcast: (body) => this.broadcast('WorldTime', body),
    });
    this.weather = new WeatherRegions({
      roster: ctx.roster,
      weather: m7.weather,
      save: () => ctx.cells.saveShared(),
    });
  }

  start(): void {
    this.clock.start();
    if (!this.resetTimer) {
      this.resetTimer = setInterval(() => void this.sweepResets(), RESET_TICK_MS);
      this.resetTimer.unref();
    }
  }

  async stop(): Promise<void> {
    this.clock.stop();
    clearInterval(this.resetTimer);
    this.resetTimer = undefined;
    await this.drain();
  }

  drain(): Promise<void> {
    return this.recordQueue.then(() => this.weather.drain());
  }

  private broadcast(name: string, body: JsLike): void {
    for (const p of this.ctx.roster.inWorld()) p.peer.sendEvent(name, body);
  }

  // Router, mirroring Quests/WorldState: returns true when `name` belongs to M7.
  handleEvent(player: Player, name: string, value: LValue | undefined): boolean {
    if (!M7_EVENTS.has(name)) return false;
    const body = value instanceof Map ? value : undefined;
    if (!body) {
      log('warn', 'm7.invalid_body', { from: player.name, name });
      return true;
    }
    switch (name) {
      case 'WorldTimeRequest': {
        // Phase 2.5: sleeping advances the clock for EVERYONE, so who may do it is a
        // world rule. Public worlds refuse outright (one stranger must not fast-forward a
        // hundred people into the night); party worlds let the leader decide for the
        // group; a solo world is unrestricted. Refusals are TOLD to the player — a Rest
        // that silently does nothing gets pressed again and then reported as a bug.
        const verdict = this.ctx.maySkipTime?.(player) ?? { may: true, why: '' };
        if (!verdict.may) {
          log('info', 'time.skip_refused', { from: player.name, why: verdict.why });
          player.restRefusedAt = Date.now();
          player.peer.sendEvent('WorldTimeRefused', { reason: verdict.why });
          break;
        }
        this.clock.request(player.name, body);
        break;
      }
      case 'WorldRegionChange': this.weather.changeRegion(player, body); break;
      case 'WorldWeather': this.weather.handleWeather(player, body); break;
      case 'RecordCreate': this.recordCreate(player, body); break;
      case 'WorldMapExplored': this.mapExplored(player, body); break;
    }
    return true;
  }

  // Join: clock + every known region's weather + the full custom-record set, before the
  // player can be handed any object referencing a custom record.
  onJoinWorld(player: Player): void {
    this.clock.sendTo((name, body) => player.peer.sendEvent(name, body));
    this.weather.sendSyncTo(player);
    this.sendRecordsSync(player);
  }

  onDisconnect(playerId: number): void {
    this.weather.onDisconnect(playerId);
  }

  // ------------------------------------------------------------- records

  private sendRecordsSync(player: Player, records: CustomRecord[] = this.ctx.records.all()): void {
    // An EMPTY world still sends one empty batch. Chunking with a bare loop skipped the send
    // entirely when there was nothing to send, which is a different statement on the wire: a
    // client waiting for RecordsSync to know the record set has arrived waits forever, and a
    // brand new world is exactly where that happens. Caught by the existing join test.
    if (records.length === 0) {
      player.peer.sendEvent('RecordsSync', { records: [] });
      return;
    }
    for (let i = 0; i < records.length; i += RECORDS_PER_SYNC) {
      player.peer.sendEvent('RecordsSync', {
        records: records.slice(i, i + RECORDS_PER_SYNC)
          .map((r) => ({ recordNetId: r.recordNetId, kind: r.kind, data: r.data })),
      });
    }
  }

  // C->S RecordCreate {tempId, kind, data} -> RecordCreateAck {tempId, recordNetId}.
  // Serialized: acks must come back in the order the client sent them, and the store
  // mints ids and awaits durability inside the same turn.
  private recordCreate(player: Player, body: LTable): void {
    const tempId = body.get('tempId');
    const kind = body.get('kind');
    const data = body.get('data');
    if (
      typeof tempId !== 'number' || !Number.isFinite(tempId) ||
      typeof kind !== 'string' || !RECORD_KINDS.has(kind) ||
      !(data instanceof Map) || data.size > MAX_RECORD_FIELDS
    ) {
      log('warn', 'records.dropped', { from: player.name, why: 'invalid shape' });
      return;
    }
    if (this.ctx.records.count() >= MAX_CUSTOM_RECORDS) {
      // Refused the same way a malformed one is: logged, and no ack. The creator's client
      // treats an unacked tempId as a failed creation, which is what happened.
      if (!this.recordFloodLogged) {
        this.recordFloodLogged = true;
        log('error', 'records.dropped', {
          from: player.name, why: 'record ceiling reached', cap: MAX_CUSTOM_RECORDS,
          note: 'no further custom records are stored in this world; every join replays them all',
        });
      }
      return;
    }
    const playerId = player.id;
    const accountKey = player.accountKey;
    const jsData = lToJs(data) as JsLike;
    if (!recordWithinCaps(jsData, kind)) {
      // Same refusal as a malformed body: logged, counted, no ack (the client treats an
      // unacked tempId as a failed creation).
      metrics.recordsRefused.inc();
      log('warn', 'records.dropped', { from: player.name, account: accountKey, kind, why: 'beyond caps' });
      return;
    }
    this.recordQueue = this.recordQueue
      .then(async () => {
        const record = await this.ctx.records.create(kind as RecordKind, jsData, accountKey);
        log('info', 'records.created', { recordNetId: record.recordNetId, kind, by: accountKey });
        // Ack the creator first (per-connection FIFO maps tempId -> recordNetId before
        // anything referencing the record arrives), then push the single new record to
        // every OTHER in-world client as a one-entry RecordsSync — peers must be able to
        // resolve the id immediately, not only after their next join.
        this.ctx.roster.get(playerId)?.peer.sendEvent('RecordCreateAck', { tempId, recordNetId: record.recordNetId });
        for (const p of this.ctx.roster.inWorld()) {
          if (p.id !== playerId) this.sendRecordsSync(p, [record]);
        }
      })
      .catch((err) => log('error', 'records.create_failed', { error: String(err) }));
  }

  // ---------------------------------------------------------- cell resets

  // Operator/plugin schedule, persisted so it survives a restart. intervalSec = 0 means
  // "registered but manual only".
  scheduleCellReset(cellKey: string, intervalSec: number): boolean {
    if (!str(cellKey, MAX_CELL_KEY) || !Number.isFinite(intervalSec) || intervalSec < 0) return false;
    const resets = this.ctx.cells.worldM7().resets;
    const existing = resets[cellKey];
    resets[cellKey] = {
      cellKey,
      intervalSec,
      // Keep the elapsed clock on a reschedule: an operator editing the interval must not
      // silently postpone a reset that was already due.
      lastResetMs: existing?.lastResetMs ?? Date.now(),
    };
    this.ctx.cells.saveShared();
    return true;
  }

  unscheduleCellReset(cellKey: string): void {
    delete this.ctx.cells.worldM7().resets[cellKey];
    this.ctx.cells.saveShared();
  }

  scheduledResets(): string[] {
    return Object.keys(this.ctx.cells.worldM7().resets);
  }

  // Wipes the cell doc and tells every client to drop its local deltas and reload.
  async resetCellNow(cellKey: string): Promise<void> {
    if (!str(cellKey, MAX_CELL_KEY)) return;
    const restored = await this.ctx.cells.resetCell(cellKey);
    const entry = this.ctx.cells.worldM7().resets[cellKey];
    if (entry) {
      entry.lastResetMs = Date.now();
      this.ctx.cells.saveShared();
    }
    log('info', 'world.cell_reset', { cellKey });
    this.broadcast('WorldCellReset', { cellKey });
    // ...and immediately hand anyone standing there the restored truth, so a reset is
    // transparent instead of a kick (TES3MP #698). Order matters: WorldCellReset tells the
    // client to drop its local view, the snapshot then refills it in the same tick.
    this.ctx.world?.sendCellSnapshot(cellKey, restored);
  }

  private async sweepResets(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try { await this.sweepResetsOnce(); } finally { this.sweeping = false; }
  }

  private async sweepResetsOnce(): Promise<void> {
    const now = Date.now();
    for (const entry of Object.values(this.ctx.cells.worldM7().resets)) {
      if (entry.intervalSec > 0 && now - entry.lastResetMs >= entry.intervalSec * 1000) {
        await this.resetCellNow(entry.cellKey);
      }
    }
  }

  // ------------------------------------------------------------ map share

  // C->S WorldMapExplored {cellKeys}; relayed to everyone else under [sharing] map.
  private mapExplored(player: Player, body: LTable): void {
    const raw = body.get('cellKeys');
    if (!(raw instanceof Map) || raw.size === 0) {
      log('warn', 'map.dropped', { from: player.name, why: 'invalid shape' });
      return;
    }
    if (raw.size > MAX_MAP_CELLS) {
      log('error', 'map.dropped', {
        from: player.name, why: 'too many cells', size: raw.size, cap: MAX_MAP_CELLS,
        note: 'map exploration stops syncing for this player until it shrinks',
      });
      return;
    }
    const cellKeys: string[] = [];
    for (const [, v] of raw) {
      const key = str(v, MAX_CELL_KEY);
      if (!key) {
        log('warn', 'map.dropped', { from: player.name, why: 'bad cellKey' });
        return;
      }
      cellKeys.push(key);
    }
    // Persist BEFORE the sharing gate: an individual map is still this character's map
    // (backlog 260: nothing was kept, and a returning host had a blank world map).
    const exterior = cellKeys.filter((k) => /^-?\d+,-?\d+$/.test(k));
    const targets = new Set([player.charId]);
    const owner = this.ctx.ownerCharId?.();
    if (owner !== undefined && this.ctx.isMapShared()) targets.add(owner);
    if (exterior.length > 0 && !player.system) {
      for (const charId of targets) {
        this.ctx.players?.update(charId, (doc) => {
          const set = new Set(doc.explored ?? []);
          for (const k of exterior) set.add(k);
          doc.explored = [...set].slice(-MAX_EXPLORED);
        });
      }
    }
    if (!this.ctx.isMapShared()) return; // individual mode: never relayed
    for (const p of this.ctx.roster.inWorld()) {
      if (p.id !== player.id) p.peer.sendEvent('WorldMapExplored', { cellKeys, byId: player.id });
    }
  }

  // The keys a joining client replays through MP_WorldMapExplored: the campaign's when the
  // map is shared and this is a guest, else the character's own (backlog 260).
  exploredFor(player: Player): string[] | undefined {
    const owner = this.ctx.ownerCharId?.();
    const source = owner !== undefined && this.ctx.isMapShared() ? owner : player.charId;
    return this.ctx.players?.getCached(source)?.explored;
  }
}
