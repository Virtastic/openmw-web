// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M3 world persistence: per-cell delta docs at <dataDir>/world/cells/<enc(cellKey)>.json
// (in-memory canonical, write-behind: 45 s sweep + cell-empty flush + signals/close),
// plus the global netId counter in <dataDir>/world/global.json. netIds are never reused:
// the counter is reserved in blocks — disk always holds a CEILING, so a crash skips at
// most one block, it never hands out a duplicate.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './atomicjson';
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
}

export type ContainerItems = { id: string; n: number }[];

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
  containers: Record<string, { items: ContainerItems; stateSeq: number; origin?: ContainerItems }>;
  // M4: last actor snapshot folded when the cell went dormant ({actors:[...]}, JSON-safe),
  // and per-actor highest processed deathNo (dedup + death persistence).
  actorOverrides?: unknown;
  actorDeaths?: Record<string, number>;
  // M6: per-object MWScript locals, refKey -> {varName: value}.
  memberVars?: Record<string, Record<string, number>>;
  // Phase 4: refKey -> false for objects a script DISABLED. Enabled is the vanilla
  // default, so only disables are recorded (see WorldState.enabled).
  enabled?: Record<string, false>;
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
}

export class CellStore {
  private readonly cellsDir: string;
  private readonly globalPath: string;
  private cache = new Map<string, CellDoc>();
  private dirty = new Set<string>();
  private sweepTimer: NodeJS.Timeout;
  private nextNetId = 1;
  private netIdCeiling = 1; // ids < ceiling are reserved on disk
  private kills = new Map<string, number>();
  private quest: SharedQuestState = emptySharedQuestState();
  private m7: WorldM7State = emptyWorldM7State();
  private globalLoaded: Promise<void>;
  private globalWrite: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.cellsDir = join(dataDir, 'world', 'cells');
    this.globalPath = join(dataDir, 'world', 'global.json');
    mkdirSync(this.cellsDir, { recursive: true });
    this.sweepTimer = setInterval(() => void this.flushAll(), SWEEP_MS);
    this.sweepTimer.unref();
    this.globalLoaded = readJson<GlobalDoc>(this.globalPath).then((g) => {
      if (g && Number.isInteger(g.nextNetIdCeiling) && g.nextNetIdCeiling > 0) {
        this.nextNetId = g.nextNetIdCeiling;
        this.netIdCeiling = g.nextNetIdCeiling;
      }
      if (g?.kills) for (const [k, v] of Object.entries(g.kills)) this.kills.set(k, v);
      if (g?.quest) this.quest = { ...emptySharedQuestState(), ...g.quest };
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

  private writeGlobalNow(): Promise<void> {
    return writeJsonAtomic(this.globalPath, {
      nextNetIdCeiling: this.netIdCeiling,
      kills: Object.fromEntries(this.kills),
      quest: this.quest,
      m7: this.m7,
    } satisfies GlobalDoc).catch((err) => log('error', 'world.global_flush_failed', { error: String(err) }));
  }

  // Monotonic u32, restart-safe; never reused.
  allocNetId(): number {
    const id = this.nextNetId++;
    if (this.nextNetId > this.netIdCeiling) {
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
      if (!cont.origin) continue; // pre-restock doc: nothing to restore it to
      const items = cont.origin.map((i) => ({ ...i }));
      // stateSeq keeps CLIMBING across a reset. A client that reconnects mid-reset must
      // never see a lower seq than one it already applied, or its own staleness guard
      // would reject the restock as an out-of-date frame.
      doc.containers[key] = { items, stateSeq: cont.stateSeq + 1, origin: cont.origin.map((i) => ({ ...i })) };
    }
    this.cache.set(cellKey, doc);
    this.dirty.add(cellKey);
    await this.flushKey(cellKey);
    return doc;
  }

  private path(cellKey: string): string {
    // Interior names can contain filesystem-hostile characters.
    return join(this.cellsDir, `${encodeURIComponent(cellKey)}.json`);
  }

  async get(cellKey: string): Promise<CellDoc> {
    const cached = this.cache.get(cellKey);
    if (cached) return cached;
    const doc = (await readJson<CellDoc>(this.path(cellKey))) ?? emptyCellDoc();
    this.cache.set(cellKey, doc);
    return doc;
  }

  getCached(cellKey: string): CellDoc | undefined {
    return this.cache.get(cellKey);
  }

  markDirty(cellKey: string): void {
    this.dirty.add(cellKey);
  }

  async flushKey(cellKey: string): Promise<void> {
    if (!this.dirty.delete(cellKey)) return;
    const doc = this.cache.get(cellKey);
    if (!doc) return;
    try {
      await timeFlush('cells', () => writeJsonAtomic(this.path(cellKey), doc));
    } catch (err) {
      this.dirty.add(cellKey);
      log('error', 'world.cell_flush_failed', { cellKey, error: String(err) });
    }
  }

  async flushAll(): Promise<void> {
    for (const key of [...this.dirty]) await this.flushKey(key);
    await this.globalWrite; // kills / shared quest state must be on disk too
  }

  async close(): Promise<void> {
    clearInterval(this.sweepTimer);
    await this.flushAll();
  }
}
