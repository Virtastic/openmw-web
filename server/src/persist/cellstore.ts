// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M3 world persistence: per-cell delta docs at <dataDir>/world/cells/<enc(cellKey)>.json
// (in-memory canonical, write-behind: 45 s sweep + cell-empty flush + signals/close),
// plus the global netId counter in <dataDir>/world/global.json. netIds are never reused:
// the counter is reserved in blocks — disk always holds a CEILING, so a crash skips at
// most one block, it never hands out a duplicate.

import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { checkpoint, openDb, tx } from './sqlite';
import { remapRefKey } from '../proto/ref';

const CELL_MIGRATIONS = [
  {
    name: '001-world',
    up: (db: DatabaseSync) => {
      // cellKey is the KEY, not a filename. The JSON layout URL-encoded it into a path
      // ("seyda%20neen%2C%20census%20and%20excise%20office.json") purely because interior
      // names contain filesystem-hostile characters — a column has no such problem.
      db.exec(`CREATE TABLE cells (
        cellKey TEXT PRIMARY KEY,
        doc     TEXT NOT NULL
      )`);
      // Single-row table: the world's counters and shared state.
      db.exec(`CREATE TABLE world_global (
        id  INTEGER PRIMARY KEY CHECK (id = 1),
        doc TEXT NOT NULL
      )`);
    },
  },
];
import { log } from '../log';
import { timeFlush } from '../metrics';

export interface PlacedObject {
  netId: number;
  recordId: string;
  cellKey: string;
  x: number;
  y: number;
  z: number;
  rotZ: number;
  count: number;
  byId: number; // transient playerId of the spawner; informational in restored state
  // The dropped item's own state (wear, charge, soul), so a pickup is not a pristine copy.
  state?: { condition?: number; charge?: number; soul?: string };
}

export type ContainerItems = { id: string; n: number }[];

// THE KEYED MAPS HAVE A CEILING TOO. placed and deleted were capped (worldstate.ts) after
// 3,400 drops made a cell undecodable; moved, locks, doors and memberVars were not, and
// ~11k ObjectMoves (three minutes at 60 msg/s from one client, each naming a fresh ref)
// pushed WorldCellState past the LSER node ceiling the same way — every entrant thereafter
// disconnected BAD_PROTO, permanently, because the doc is persisted. Same number as
// MAX_PLACED_PER_CELL: far past any honest cell, half the ceiling left for the rest.
export const MAX_KEYS_PER_CELL = 2000;

/** True (and logged) when `key` is NEW to `map` and the map is already at the cap. An
 *  existing key always updates: the cap bounds growth, not play. `size` overrides the
 *  count for a map whose entries are nested (memberVars). */
export function cellMapFull(
  map: Record<string, unknown>, key: string, cellKey: string, what: string, by: string, size?: number,
): boolean {
  if (key in map) return false;
  if ((size ?? Object.keys(map).length) < MAX_KEYS_PER_CELL) return false;
  log('warn', 'world.cell_map_full', { cellKey, map: what, by, cap: MAX_KEYS_PER_CELL });
  return true;
}

export interface CellDoc {
  placed: Record<string, PlacedObject>; // key "n:<netId>"
  deleted: string[]; // refKey tombstones
  moved: Record<string, { x: number; y: number; z: number; rotZ: number }>; // content refs
  locks: Record<string, number | null>; // null = unlocked
  doors: Record<string, boolean>; // open?
  // `origin` is the FIRST-SEEN contents (the leveled-loot roll that became canonical).
  // Kept so a reset can RESTOCK the container rather than merely forgetting it: a client
  // already standing there has no idea what was originally inside, and TES3MP's answer —
  // kick everyone, or let them desync — is the failure this exists to avoid. It also
  // makes merchant gold come back, the other half of that same complaint.
  // `gold` is a MERCHANT's purse, present only for containers that are actually traders.
  // It has to be canonical for the same reason the stock does: left per-client, every player
  // sells into a purse that never empties, which is the other half of the merchant
  // duplication. Trainers touch this field and nothing else.
  // `goldRestockAt` is an ABSOLUTE game-hour reading, not a wall clock: a merchant restocks
  // on the world's calendar, which players can push forward by resting.
  containers: Record<string, {
    items: ContainerItems; stateSeq: number; origin?: ContainerItems;
    gold?: number; goldOrigin?: number; goldRestockAt?: number;
  }>;
  // M4: last actor snapshot folded when the cell went dormant ({actors:[...]}, JSON-safe),
  // and per-actor highest processed deathNo (dedup + death persistence) with the ABSOLUTE
  // game hour it happened at, so the record expires on fCorpseRespawnDelay (WorldState
  // .liveDeaths). Older docs hold a bare deathNo; WorldState.deathsOf upgrades them in place.
  actorOverrides?: unknown;
  actorDeaths?: Record<string, { deathNo: number; atH: number }>;
  // M6: per-object MWScript locals, refKey -> {varName: value}.
  memberVars?: Record<string, Record<string, number>>;
  // Phase 4: refKey -> the enabled state a script last set. A `true` is a scripted reveal
  // (backlog 218) replayed on entry; an absent key is whatever the content files say.
  enabled?: Record<string, boolean>;
  // Who follows whom, refKey -> the CHARACTER followed (a session id dies with the process;
  // WorldState.hydrateFollows resolves it back to one). Escort rides along as claimed.
  follows?: Record<string, { charId: string; escort?: Record<string, number> }>;
}

export function emptyCellDoc(): CellDoc {
  return { placed: {}, deleted: [], moved: {}, locks: {}, doors: {}, containers: {} };
}

const SWEEP_MS = 45_000;
const NET_ID_BLOCK = 128;

// M6 shared world state lives alongside the M3/M4 counters in world/global.json.
export interface FactionState {
  rank: number;
  reputation?: number;
  expelled?: boolean;
}

export interface SharedQuestState {
  journal: Record<string, number>; // questId -> arbitrated index
  globals: Record<string, { value: number; seq: number }>; // MWScript globals + LWW seq
  factions: Record<string, FactionState>;
  bounty: number; // shared crime bounty
}

export function emptySharedQuestState(): SharedQuestState {
  return { journal: {}, globals: {}, factions: {}, bounty: 0 };
}

// M7 world state, persisted next to the M3/M4/M6 globals in world/global.json.
export interface WorldTimeState {
  gameHour: number;
  day: number;
  month: number;
  year: number;
  timeScale: number;
}

export interface WeatherState {
  current: number;
  next?: number;
  transition?: number;
}

export interface CellResetEntry {
  cellKey: string;
  intervalSec: number; // 0 = manual only (operator/plugin driven)
  lastResetMs: number; // wall clock of the last reset; survives restart
}

export interface WorldM7State {
  time: WorldTimeState;
  // Last known weather per region, handed to the next region authority on claim.
  weather: Record<string, WeatherState>;
  resets: Record<string, CellResetEntry>; // cellKey -> schedule
}

export function emptyWorldM7State(): WorldM7State {
  // Morrowind's own start date; timeScale 30 = vanilla.
  return { time: { gameHour: 9, day: 16, month: 7, year: 427, timeScale: 30 }, weather: {}, resets: {} };
}

interface GlobalDoc {
  nextNetIdCeiling: number;
  kills?: Record<string, number>; // M4 shared kill tally, per base recordId
  quest?: SharedQuestState; // M6
  m7?: WorldM7State; // M7 clock / weather / cell-reset schedule
  // Backlog 298: the content list (file names, load order) every c:<index>:<contentFile>
  // key in the cell docs was written against. Stamped when the peer's manifest becomes
  // authoritative; a later boot under a different list remaps the keys (setContentList).
  content?: string[];
}

/** Rewrites every content-ref key in `doc` through `idxMap` IN PLACE (references held by a
 *  live WorldState stay valid). Keys whose file is gone are dropped. actorOverrides is a
 *  dormant snapshot of the peer's own actors, keyed the same way inside an opaque blob: it
 *  is cleared rather than walked, and the peer re-simulates the cell from content. */
export function remapCellDoc(doc: CellDoc, idxMap: Map<number, number>): { changed: number; dropped: number } {
  let changed = 0, dropped = 0;
  const rk = (k: string): string | null => remapRefKey(k, idxMap);
  const rekey = (rec: Record<string, unknown> | undefined): void => {
    if (!rec) return;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      const nk = rk(k);
      if (nk === null) { dropped++; continue; }
      if (nk !== k) changed++;
      out[nk] = v;
    }
    for (const k of Object.keys(rec)) delete rec[k];
    Object.assign(rec, out);
  };
  rekey(doc.moved); rekey(doc.locks); rekey(doc.doors); rekey(doc.containers);
  rekey(doc.actorDeaths); rekey(doc.memberVars); rekey(doc.enabled); rekey(doc.follows);
  const deleted: string[] = [];
  for (const k of doc.deleted) {
    const nk = rk(k);
    if (nk === null) { dropped++; continue; }
    if (nk !== k) changed++;
    deleted.push(nk);
  }
  doc.deleted.splice(0, doc.deleted.length, ...deleted);
  if (doc.actorOverrides !== undefined) { delete doc.actorOverrides; dropped++; }
  return { changed, dropped };
}

export class CellStore {
  private readonly db: DatabaseSync;
  private cache = new Map<string, CellDoc>();
  private dirty = new Set<string>();
  private sweepTimer: NodeJS.Timeout;
  private nextNetId = 1;
  private netIdCeiling = 1; // ids < ceiling are reserved on disk
  private kills = new Map<string, number>();
  private quest: SharedQuestState = emptySharedQuestState();
  private m7: WorldM7State = emptyWorldM7State();
  private content: string[] | undefined;
  private globalLoaded: Promise<void>;
  private globalWrite: Promise<void> = Promise.resolve();

  /** Does a cell reset RESTOCK containers to their first-seen contents?
   *
   *  True everywhere a campaign is played, so a world does not stay stripped. False in the
   *  shared world, where it is an item faucet: cells there reset on a timer AND anything a
   *  character is carrying now follows them home (it has to, or dropping something there
   *  does not stick). Loot a chest, wait for the reset, loot it again, walk home with all of
   *  it. Everything else a reset does — clearing placements, deaths, locks — still happens;
   *  a looted container in the shared world simply stays looted. */
  private readonly restockOnReset: boolean;

  constructor(dataDir: string, restockOnReset = true) {
    this.restockOnReset = restockOnReset;
    this.db = openDb(join(dataDir, 'world', 'world.db'), CELL_MIGRATIONS);
    this.sweepTimer = setInterval(() => void this.flushAll(), SWEEP_MS);
    this.sweepTimer.unref();
    this.globalLoaded = Promise.resolve(this.loadGlobal()).then((g) => {
      if (g && Number.isInteger(g.nextNetIdCeiling) && g.nextNetIdCeiling > 0) {
        this.nextNetId = g.nextNetIdCeiling;
        this.netIdCeiling = g.nextNetIdCeiling;
      }
      if (g?.kills) for (const [k, v] of Object.entries(g.kills)) this.kills.set(k, v);
      if (g?.quest) this.quest = { ...emptySharedQuestState(), ...g.quest };
      if (Array.isArray(g?.content)) this.content = g.content.map(String);
      if (g?.m7) {
        const base = emptyWorldM7State();
        this.m7 = {
          time: { ...base.time, ...g.m7.time },
          weather: g.m7.weather ?? {},
          resets: g.m7.resets ?? {},
        };
      }
    });
  }

  ready(): Promise<void> {
    return this.globalLoaded;
  }

  private writeGlobal(): void {
    // Serialized behind the previous write (atomic tmp+rename each time) and tracked so
    // flush/close can await durability — a kill tally or journal advance must not be lost
    // on shutdown. The netId ceiling always leads the counter, so a crash skips a block
    // rather than reissuing an id.
    this.globalWrite = this.globalWrite.then(() => this.writeGlobalNow());
  }

  private async writeGlobalNow(): Promise<void> {
    try {
      const doc: GlobalDoc = {
        nextNetIdCeiling: this.netIdCeiling,
        kills: Object.fromEntries(this.kills),
        quest: this.quest,
        m7: this.m7,
        ...(this.content ? { content: this.content } : {}),
      };
      this.db
        .prepare('INSERT INTO world_global (id, doc) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc')
        .run(JSON.stringify(doc));
    } catch (err) {
      log('error', 'world.global_flush_failed', { error: String(err) });
    }
  }

  // Reads the world's single global row (netId ceiling, kill tallies, shared quest/M7 state).
  private loadGlobal(): GlobalDoc | undefined {
    const row = this.db.prepare('SELECT doc FROM world_global WHERE id = 1').get() as
      { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as GlobalDoc) : undefined;
  }

  // Monotonic u32, restart-safe; never reused.
  allocNetId(): number {
    const id = this.nextNetId++;
    // `>=`, not `>`: ids BELOW the ceiling are the ones reserved on disk. At `nextNetId ===
    // ceiling` the id just handed out is the ceiling itself, so a crash before the next
    // writeGlobal lands would restart at the same value and issue it twice -- two live
    // objects sharing a netId the protocol assumes is unique forever.
    if (this.nextNetId >= this.netIdCeiling) {
      this.netIdCeiling = this.nextNetId + NET_ID_BLOCK;
      this.writeGlobal();
    }
    return id;
  }

  bumpKill(refId: string): number {
    const n = (this.kills.get(refId) ?? 0) + 1;
    this.kills.set(refId, n);
    this.writeGlobal();
    return n;
  }

  killCount(refId: string): number {
    return this.kills.get(refId) ?? 0;
  }

  /** Every record with a tally, for the join-time replay (GetDeadCount on a fresh engine). */
  allKills(): [string, number][] {
    return [...this.kills.entries()];
  }

  // M6 shared quest state. Mutate through sharedQuest() then call saveShared() — writes
  // are atomic and coalesced by the same fire-and-forget path as the counters.
  sharedQuest(): SharedQuestState {
    return this.quest;
  }

  saveShared(): void {
    this.writeGlobal();
  }

  // M7 world state (clock, per-region weather, cell-reset schedule). Same contract as
  // sharedQuest(): mutate in place, then saveShared() to schedule the atomic write.
  worldM7(): WorldM7State {
    return this.m7;
  }

  contentList(): string[] | undefined {
    return this.content;
  }

  /** Backlog 298: pin the world's content list (names in load order, i.e. the contentFile
   *  index space every c: key lives in). Synchronous on purpose — node:sqlite is, and a
   *  remap that ran while the peer was already sending events for a cell would race it.
   *
   *  No stored list = a world from before the stamp: adopt now and continue (null). Same list
   *  = nothing to do. A different list = rewrite every cell doc, cached and on disk, by file
   *  NAME: a key whose file moved gets its new index, one whose file is gone is dropped.
   *  Case-insensitive, as the engine resolves content files. */
  setContentList(names: string[]): { changed: number; dropped: number } | null {
    const same = this.content !== undefined && this.content.length === names.length
      && this.content.every((n, i) => n.toLowerCase() === names[i]!.toLowerCase());
    if (same) return null;
    let result: { changed: number; dropped: number } | null = null;
    if (this.content !== undefined) {
      const newIdx = new Map(names.map((n, i) => [n.toLowerCase(), i]));
      const idxMap = new Map<number, number>();
      for (const [i, n] of this.content.entries()) {
        const to = newIdx.get(n.toLowerCase());
        if (to !== undefined) idxMap.set(i, to);
      }
      let changed = 0, dropped = 0;
      const seen = new Set<string>();
      tx(this.db, () => {
        const rows = this.db.prepare('SELECT cellKey, doc FROM cells').all() as { cellKey: string; doc: string }[];
        const upd = this.db.prepare('UPDATE cells SET doc = ? WHERE cellKey = ?');
        for (const row of rows) {
          seen.add(row.cellKey);
          const cached = this.cache.get(row.cellKey);
          const doc = cached ?? (JSON.parse(row.doc) as CellDoc);
          const r = remapCellDoc(doc, idxMap);
          changed += r.changed; dropped += r.dropped;
          if (cached) this.dirty.add(row.cellKey);
          else if (r.changed || r.dropped) upd.run(JSON.stringify(doc), row.cellKey);
        }
        for (const [key, doc] of this.cache) {
          if (seen.has(key)) continue;
          const r = remapCellDoc(doc, idxMap);
          changed += r.changed; dropped += r.dropped;
          this.dirty.add(key);
        }
      });
      result = { changed, dropped };
      log('warn', 'world.content_remapped', { changed, dropped, from: this.content.join(','), to: names.join(',') });
    }
    this.content = [...names];
    this.writeGlobal();
    return result;
  }

  // Wipes every delta for a cell (M7 operator reset) and flushes it immediately, so a
  // crash right after a reset cannot resurrect the old doc from disk.
  // Reset to the content-file state. Containers are RESTOCKED to their first-seen roll
  // rather than forgotten: a client standing in the cell cannot reconstruct what was
  // originally inside, so "forget it" leaves them looking at a looted chest forever while
  // the server thinks it is full. Returns the restored doc so the caller can push an
  // authoritative snapshot to whoever is standing there (see WorldState.sendCellSnapshot).
  async resetCell(cellKey: string): Promise<CellDoc> {
    const before = this.cache.get(cellKey) ?? (await this.get(cellKey));
    const doc = emptyCellDoc();
    for (const [key, cont] of Object.entries(before.containers)) {
      if (!this.restockOnReset) {
        // Shared world: CARRY THE ROW FORWARD, looted as it stands. Dropping it looked the
        // same from outside but re-armed the faucet: containerOpen treats a missing row as
        // "first open" and adopts the opener's client-declared contents as canonical, so the
        // very next open after a reset re-seeded the full roll. A row that persists means
        // there is no "first open" ever again.
        // gold rides along for the same reason the row does: dropping it re-arms the faucet
        // for the PURSE, because containerOpen adopts the opener's client-declared gold when
        // the field is missing. A carried-forward merchant stays as drained as it was.
        doc.containers[key] = { items: cont.items.map((i) => ({ ...i })), stateSeq: cont.stateSeq + 1,
          ...(cont.origin ? { origin: cont.origin.map((i) => ({ ...i })) } : {}),
          ...(cont.gold !== undefined ? { gold: cont.gold } : {}),
          ...(cont.goldOrigin !== undefined ? { goldOrigin: cont.goldOrigin } : {}),
          ...(cont.goldRestockAt !== undefined ? { goldRestockAt: cont.goldRestockAt } : {}) };
        continue;
      }
      if (!cont.origin) continue; // pre-restock doc: nothing to restore it to
      const items = cont.origin.map((i) => ({ ...i }));
      // stateSeq keeps CLIMBING across a reset. A client that reconnects mid-reset must
      // never see a lower seq than one it already applied, or its own staleness guard
      // would reject the restock as an out-of-date frame.
      // A restock refills the purse too -- a merchant whose stock is back but whose gold is
      // still zero cannot buy anything, which is half a restock.
      doc.containers[key] = { items, stateSeq: cont.stateSeq + 1, origin: cont.origin.map((i) => ({ ...i })),
        ...(cont.goldOrigin !== undefined ? { gold: cont.goldOrigin, goldOrigin: cont.goldOrigin } : {}),
        ...(cont.goldRestockAt !== undefined ? { goldRestockAt: cont.goldRestockAt } : {}) };
    }
    this.cache.set(cellKey, doc);
    this.dirty.add(cellKey);
    await this.flushKey(cellKey);
    return doc;
  }



  async get(cellKey: string): Promise<CellDoc> {
    const cached = this.cache.get(cellKey);
    if (cached) return cached;
    const row = this.db.prepare('SELECT doc FROM cells WHERE cellKey = ?').get(cellKey) as
      { doc: string } | undefined;
    const doc = row ? (JSON.parse(row.doc) as CellDoc) : emptyCellDoc();
    this.cache.set(cellKey, doc);
    return doc;
  }

  /** Every cell this world has stored deltas for — i.e. every cell somebody has CHANGED.
   *
   *  Exactly the set that accumulates litter, and nothing else: a cell nobody has touched has
   *  no row, so this never proposes resetting the whole map. Reads the table rather than the
   *  cache because the cache only holds what is currently loaded, and litter outlives that. */
  cellsWithDeltas(): string[] {
    try {
      const rows = this.db.prepare('SELECT cellKey FROM cells').all() as { cellKey: string }[];
      const keys = new Set(rows.map((r) => r.cellKey));
      // Dirty-but-unflushed cells live only in memory until the next sweep; a litter pass
      // that ran between a drop and its flush would otherwise miss the cell entirely.
      for (const k of this.dirty) keys.add(k);
      return [...keys];
    } catch (err) {
      log('error', 'world.cell_list_failed', { error: String(err) });
      return [];
    }
  }

  getCached(cellKey: string): CellDoc | undefined {
    return this.cache.get(cellKey);
  }

  markDirty(cellKey: string): void {
    this.dirty.add(cellKey);
  }

  // KNOWN, DELIBERATELY NOT FIXED HERE: this cache is never evicted, so a long-lived world
  // retains every cell any player entered (placements, container contents, actor overrides,
  // memberVars) and the gateway's memory governor prices a world as a constant. The obvious
  // fix -- release on onCellVacated -- is NOT safe: worldstate's queue serialises its own
  // mutations, but quests.storeMemberVar mutates a doc on a DETACHED promise, so a release
  // landing between its get() and markDirty() would leave the mutation on an orphaned object
  // and flushKey would then find no cache entry and clear the dirty flag -- a silently lost
  // write. Doing this properly needs every mutation path serialised (or an LRU that keys off
  // live references) and is not worth trading a data-loss race for a slow leak.
  async flushKey(cellKey: string): Promise<void> {
    if (!this.dirty.delete(cellKey)) return;
    const doc = this.cache.get(cellKey);
    if (!doc) return;
    try {
      await timeFlush('cells', async () =>
        this.db
          .prepare('INSERT OR REPLACE INTO cells (cellKey, doc) VALUES (?, ?)')
          .run(cellKey, JSON.stringify(doc)),
      );
    } catch (err) {
      this.dirty.add(cellKey);
      log('error', 'world.cell_flush_failed', { cellKey, error: String(err) });
    }
  }

  async flushAll(): Promise<void> {
    for (const key of [...this.dirty]) await this.flushKey(key);
    await this.globalWrite; // kills / shared quest state must be on disk too
    checkpoint(this.db);
  }

  async close(): Promise<void> {
    clearInterval(this.sweepTimer);
    await this.flushAll();
  }
}
