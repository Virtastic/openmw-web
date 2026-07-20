// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Per-player persistence (M2): in-memory canonical doc + dirty flag, write-behind to
// <dataDir>/players/<nameLower>.json via atomic tmp+fsync+rename. Flush points per
// PROTOCOL.md: cell change, level-up, equipment (10 s debounce), logout, SIGTERM/SIGUSR1,
// plus a 45 s staggered sweep. Position coords are refreshed from the live pose at flush
// time so move frames never dirty the doc.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './atomicjson';
import { log } from '../log';

export interface PlayerAppearanceDoc {
  race: string;
  head: string;
  hair: string;
  isMale: boolean;
  class: string;
  name: string;
}

// Type alias (not interface) so it structurally satisfies JsLike's index signature.
export type DynamicStatDoc = {
  c: number;
  b: number;
};

export interface PlayerDoc {
  appearance?: PlayerAppearanceDoc;
  equipment?: Record<number, string>; // slot -> recordId (keys stringify in JSON; normalized on load)
  inventory?: { id: string; n: number }[];
  stats?: {
    dynamic?: { hp: DynamicStatDoc; mp: DynamicStatDoc; ft: DynamicStatDoc };
    attributes?: Record<string, number>;
    skills?: Record<string, number>;
    level?: number;
  };
  spells?: string[];
  position?: { cellKey: string; x: number; y: number; z: number };
}

export type LivePosition = { cellKey: string; x: number; y: number; z: number };

const SWEEP_MS = 45_000;
const EQUIP_DEBOUNCE_MS = 10_000;

export class PlayerStore {
  private readonly dir: string;
  private cache = new Map<string, PlayerDoc>(); // key = account nameLower
  private dirty = new Set<string>();
  private debounce = new Map<string, NodeJS.Timeout>();
  private sweepTimer: NodeJS.Timeout;
  // Supplies the freshest position for online players at flush time.
  private livePosition: (key: string) => LivePosition | undefined = () => undefined;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'players');
    mkdirSync(this.dir, { recursive: true });
    this.sweepTimer = setInterval(() => void this.flushAll(), SWEEP_MS);
    this.sweepTimer.unref();
  }

  setLivePositionProvider(fn: (key: string) => LivePosition | undefined): void {
    this.livePosition = fn;
  }

  private path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  // undefined = no snapshot yet (fresh chargen). Loaded docs are cached as canonical.
  async get(key: string): Promise<PlayerDoc | undefined> {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const loaded = await readJson<PlayerDoc>(this.path(key));
    if (!loaded) return undefined;
    // JSON turned equipment slot keys into strings; normalize back to numbers.
    if (loaded.equipment) {
      const eq: Record<number, string> = {};
      for (const [k, v] of Object.entries(loaded.equipment)) eq[Number(k)] = v;
      loaded.equipment = eq;
    }
    this.cache.set(key, loaded);
    return loaded;
  }

  // Synchronous view for fan-out paths (docs of connected players are always cached,
  // because login always calls get()).
  getCached(key: string): PlayerDoc | undefined {
    return this.cache.get(key);
  }

  // Mutate the canonical doc (created on first touch) and mark it dirty.
  // flush: 'now' writes immediately, 'debounced' waits EQUIP_DEBOUNCE_MS collapsing
  // bursts, 'sweep' leaves it to the 45 s sweep / next explicit flush.
  update(key: string, fn: (doc: PlayerDoc) => void, flush: 'now' | 'debounced' | 'sweep' = 'sweep'): void {
    let doc = this.cache.get(key);
    if (!doc) {
      doc = {};
      this.cache.set(key, doc);
    }
    fn(doc);
    this.dirty.add(key);
    if (flush === 'now') {
      void this.flushKey(key);
    } else if (flush === 'debounced' && !this.debounce.has(key)) {
      const timer = setTimeout(() => {
        this.debounce.delete(key);
        void this.flushKey(key);
      }, EQUIP_DEBOUNCE_MS);
      timer.unref();
      this.debounce.set(key, timer);
    }
  }

  async flushKey(key: string): Promise<void> {
    if (!this.dirty.has(key)) return;
    this.dirty.delete(key);
    const pending = this.debounce.get(key);
    if (pending) {
      clearTimeout(pending);
      this.debounce.delete(key);
    }
    const doc = this.cache.get(key);
    if (!doc) return;
    const live = this.livePosition(key);
    if (live) doc.position = { ...live };
    try {
      await writeJsonAtomic(this.path(key), doc);
    } catch (err) {
      this.dirty.add(key); // retry on the next flush point
      log('error', 'players.flush_failed', { player: key, error: String(err) });
    }
  }

  async flushAll(): Promise<void> {
    for (const key of [...this.dirty]) await this.flushKey(key);
  }

  // Docs stay cached after logout: they are tiny, getCached() must stay valid across a
  // supersede (the new session loads before the old one tears down), and rejoin is the
  // common case. Disk remains the crash-safe copy.

  async close(): Promise<void> {
    clearInterval(this.sweepTimer);
    for (const timer of this.debounce.values()) clearTimeout(timer);
    this.debounce.clear();
    await this.flushAll();
  }
}
