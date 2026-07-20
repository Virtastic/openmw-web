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
  containers: Record<string, { items: ContainerItems; stateSeq: number }>;
}

export function emptyCellDoc(): CellDoc {
  return { placed: {}, deleted: [], moved: {}, locks: {}, doors: {}, containers: {} };
}

const SWEEP_MS = 45_000;
const NET_ID_BLOCK = 128;

interface GlobalDoc {
  nextNetIdCeiling: number;
}

export class CellStore {
  private readonly cellsDir: string;
  private readonly globalPath: string;
  private cache = new Map<string, CellDoc>();
  private dirty = new Set<string>();
  private sweepTimer: NodeJS.Timeout;
  private nextNetId = 1;
  private netIdCeiling = 1; // ids < ceiling are reserved on disk
  private globalLoaded: Promise<void>;

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
    });
  }

  ready(): Promise<void> {
    return this.globalLoaded;
  }

  // Monotonic u32, restart-safe. Fire-and-forget ceiling writes are ordered by the
  // atomic tmp+rename; on crash the unflushed block is skipped, never reissued.
  allocNetId(): number {
    const id = this.nextNetId++;
    if (this.nextNetId > this.netIdCeiling) {
      this.netIdCeiling = this.nextNetId + NET_ID_BLOCK;
      void writeJsonAtomic(this.globalPath, { nextNetIdCeiling: this.netIdCeiling } satisfies GlobalDoc).catch(
        (err) => log('error', 'world.netid_flush_failed', { error: String(err) }),
      );
    }
    return id;
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
      await writeJsonAtomic(this.path(cellKey), doc);
    } catch (err) {
      this.dirty.add(cellKey);
      log('error', 'world.cell_flush_failed', { cellKey, error: String(err) });
    }
  }

  async flushAll(): Promise<void> {
    for (const key of [...this.dirty]) await this.flushKey(key);
  }

  async close(): Promise<void> {
    clearInterval(this.sweepTimer);
    await this.flushAll();
  }
}
