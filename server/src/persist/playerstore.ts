// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Per-player persistence (M2): in-memory canonical doc + dirty flag, write-behind to
// <dataDir>/players/<nameLower>.json via atomic tmp+fsync+rename. Flush points per
// PROTOCOL.md: cell change, level-up, equipment (10 s debounce), logout, SIGTERM/SIGUSR1,
// plus a 45 s staggered sweep. Position coords are refreshed from the live pose at flush
// time so move frames never dirty the doc.

import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, tx } from './sqlite';

const PLAYER_MIGRATIONS = [
  {
    name: '001-players',
    up: (db: DatabaseSync) => {
      // key is the character id. The doc is stored whole: it is a snapshot the game reads and
      // writes as a unit, and splitting inventory/journal into tables would buy nothing but
      // join cost on the hottest write path in the server.
      db.exec(`CREATE TABLE players (
        key TEXT PRIMARY KEY,
        doc TEXT NOT NULL
      )`);
    },
  },
];
import { log } from '../log';
import { timeFlush } from '../metrics';

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
  // Character slots: one doc per CHARACTER, shared across worlds — but a position only
  // makes sense in the world it was recorded in. positions is keyed by world id;
  // `position` stays as this world's materialized view (set on load, folded back on
  // flush) so every existing caller keeps working untouched.
  positions?: Record<string, { cellKey: string; x: number; y: number; z: number }>;
  // M6: this player's own view. Always written (even in shared mode, so a family can be
  // switched to individual later without losing history); relayed only per [sharing].
  journal?: Record<string, number>; // questId -> highest index this player reported
  // Phase 4: character-shadowed mwscript globals — quest progress variables that must NOT
  // travel between players (see quests.ts WORLD_GLOBALS). Restored on join/world-hop.
  globals?: Record<string, number>;
  factions?: Record<string, { rank: number; reputation?: number; expelled?: boolean }>;
  bounty?: number;
}

export type LivePosition = { cellKey: string; x: number; y: number; z: number };

const SWEEP_MS = 45_000;
const EQUIP_DEBOUNCE_MS = 10_000;

export class PlayerStore {
  // Phase H: accounts that own no character. A sim peer connects as a client but has no
  // inventory, stats or progress to keep — persisting a doc for it writes junk into
  // players/ and, worse, would restore stale state onto a freshly spawned peer. Registered
  // at join and cleared at leave.
  private ephemeral = new Set<string>();

  markEphemeral(key: string): void {
    this.ephemeral.add(key);
    this.cache.delete(key);
    this.dirty.delete(key);
  }


  // Withhold the DISK WRITE while a character is still in Morrowind's opening sequence. The
  // in-memory doc is built normally — quests, stats and position all work for the session —
  // only nothing reaches players/ until creation finishes. Suppressing the doc itself instead
  // (markEphemeral) also stops it forming, which breaks state sync for the very characters
  // this is meant to protect.
  //
  // Why withhold at all: a doc captured partway through a scripted sequence restores a
  // half-built character into a script that has already moved past the step that built it, so
  // what comes back is not what was saved. Cleared by allowSaves() on ChargenComplete.
  private creating = new Set<string>();

  suppressSaves(key: string): void { this.creating.add(key); }
  allowSaves(key: string): void { this.creating.delete(key); }

  private cache = new Map<string, PlayerDoc>(); // key = account nameLower
  private dirty = new Set<string>();
  private debounce = new Map<string, NodeJS.Timeout>();
  private sweepTimer: NodeJS.Timeout;
  // Supplies the freshest position for online players at flush time.
  private livePosition: (key: string) => LivePosition | undefined = () => undefined;

  private readonly worldId: string;
  private readonly db: DatabaseSync;

  // dataDir: where docs live — under the F3 gateway this is the SHARED dir, so a character
  // doc follows the player across worlds. worldId scopes positions.
  constructor(dataDir: string, worldId = 'default') {
    this.db = openDb(join(dataDir, 'players.db'), PLAYER_MIGRATIONS);
    this.worldId = worldId;
    this.sweepTimer = setInterval(() => void this.flushAll(), SWEEP_MS);
    this.sweepTimer.unref();
  }

  setLivePositionProvider(fn: (key: string) => LivePosition | undefined): void {
    this.livePosition = fn;
  }



  // Character deletion: drop the cached copy FIRST so a pending sweep cannot rewrite the row
  // we are about to delete, then remove it. A missing row is already gone, not an error.
  async erase(key: string): Promise<void> {
    this.cache.delete(key);
    this.dirty.delete(key);
    await Promise.resolve();
    try {
      this.db.prepare('DELETE FROM players WHERE key = ?').run(key);
    } catch (err) {
      log('warn', 'playerstore.erase_failed', { key, error: String(err) });
    }
  }

  // undefined = no snapshot yet (fresh chargen). Loaded docs are cached as canonical.
  async get(key: string): Promise<PlayerDoc | undefined> {
    const cached = this.cache.get(key);
    if (cached) return cached;
    return this.loadSync(key);
  }

  /** Read a doc straight off disk and cache it. node:sqlite is synchronous, so this is a
   *  plain function call — which is what lets update() use it too.
   *
   *  update() used to FABRICATE an empty doc on a cache miss. Every miss therefore became a
   *  silent truncation: the stub gets one field written into it and flushKey stores it with
   *  INSERT OR REPLACE, so inventory, stats, journal and appearance are dropped from the row.
   *  A cache miss is normal (a supersede tearing down the previous session, an eviction, a
   *  path that writes before anyone read) and must never mean "this character is new". */
  private loadSync(key: string): PlayerDoc | undefined {
    const row = this.db.prepare('SELECT doc FROM players WHERE key = ?').get(key) as
      { doc: string } | undefined;
    if (!row) return undefined;
    const loaded = JSON.parse(row.doc) as PlayerDoc;
    // JSON turned equipment slot keys into strings; normalize back to numbers.
    if (loaded.equipment) {
      const eq: Record<number, string> = {};
      for (const [k, v] of Object.entries(loaded.equipment)) eq[Number(k)] = v;
      loaded.equipment = eq;
    }
    this.materializePosition(loaded);
    this.cache.set(key, loaded);
    return loaded;
  }

  // `position` in memory is always THIS world's position. A doc written by another world
  // must not teleport the player here; absent an entry for this world the player gets the
  // default spawn (no position at all).
  private materializePosition(doc: PlayerDoc): void {
    if (doc.positions) {
      const mine = doc.positions[this.worldId];
      if (mine) doc.position = { ...mine };
      else delete doc.position;
    }
    // No positions map = pre-slot doc from this world's own dir; keep legacy position as-is.
  }

  /** This character has left THIS world. Flush first, then forget it.
   *
   *  get() answers from the cache and never re-reads disk, and flushKey writes the WHOLE doc
   *  with INSERT OR REPLACE. A long-lived world (the shared one never restarts) therefore held
   *  a snapshot from the player's last visit for as long as it stayed up: play at home for an
   *  hour, come back, and its next flush replaced that hour with the stale copy. Silent, and
   *  it destroyed real progress.
   *
   *  Forgetting is safe precisely because the doc was just written: the next join re-reads it
   *  from disk, which is the only copy that can be current when several world processes share
   *  one players.db. */
  async releaseCached(key: string): Promise<void> {
    if (this.dirty.has(key)) await this.flushKey(key);
    this.cache.delete(key);
    this.dirty.delete(key);
    this.creating.delete(key);
    // The sim-peer flag is per-connection state too. clearEphemeral existed for this and was
    // never called anywhere, so a key stayed ephemeral for the life of the process.
    this.ephemeral.delete(key);
  }

  // Character-slot migration: adopt a pre-slot account-keyed doc under a character id.
  // Synchronous view for fan-out paths (docs of connected players are always cached,
  // because login always calls get()).
  getCached(key: string): PlayerDoc | undefined {
    return this.cache.get(key);
  }

  // Mutate the canonical doc (created on first touch) and mark it dirty.
  // flush: 'now' writes immediately, 'debounced' waits EQUIP_DEBOUNCE_MS collapsing
  // bursts, 'sweep' leaves it to the 45 s sweep / next explicit flush.
  update(key: string, fn: (doc: PlayerDoc) => void, flush: 'now' | 'debounced' | 'sweep' = 'sweep'): void {
    if (this.ephemeral.has(key)) return; // a sim peer has no character to save
    // Cache, then DISK, and only then a genuinely new character. Fabricating on a miss is
    // what made a miss destructive — see loadSync.
    let doc = this.cache.get(key) ?? this.loadSync(key);
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
    // Still in character creation: keep the doc in memory and leave the dirty flag set, so the
    // first flush after ChargenComplete writes everything that happened meanwhile.
    if (this.creating.has(key)) return;
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
    // Fold this world's position back into the per-world map before it hits disk, so a doc
    // shared across worlds never clobbers another world's position with ours.
    if (doc.position) (doc.positions ??= {})[this.worldId] = { ...doc.position };
    try {
      await timeFlush('players', async () =>
        this.db.prepare('INSERT OR REPLACE INTO players (key, doc) VALUES (?, ?)')
          .run(key, JSON.stringify(doc)),
      );
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
