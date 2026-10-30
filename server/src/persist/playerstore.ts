// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Per-player persistence (M2): in-memory canonical doc + dirty flag, write-behind to
// <dataDir>/players/<nameLower>.json via atomic tmp+fsync+rename. Flush points per
// PROTOCOL.md: cell change, level-up, equipment (10 s debounce), logout, SIGTERM/SIGUSR1,
// plus a 45 s staggered sweep. Position coords are refreshed from the live pose at flush
// time so move frames never dirty the doc.

import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkpoint, openDb, tx } from './sqlite';

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
  {
    // A DELETION OUTLIVES THE PROCESSES THAT STILL HOLD THE DOC. Every world has the store
    // open and caches whole docs; the gateway deleting a character cleared only its own cache,
    // and a world the character was a guest in wrote the doc straight back at its next flush
    // -- a row with no slot pointing at it. The tombstone tells any flush to drop the doc
    // instead. Lifted when a NEW character takes the key (chargen begins under it).
    name: '002-erased',
    up: (db: DatabaseSync) => { db.exec('CREATE TABLE erased (key TEXT PRIMARY KEY, at INTEGER NOT NULL)'); },
  },
  {
    // OT3-41: ONE WORLD. positions was keyed by world id (priv- worlds, the old public one);
    // each character now keeps one entry, the place they last stood, under WORLD_ID.
    name: '003-one-world-positions',
    up: (db: DatabaseSync) => {
      const rows = db.prepare(`SELECT key, doc FROM players WHERE json_extract(doc, '$.positions') IS NOT NULL`)
        .all() as { key: string; doc: string }[];
      const write = db.prepare('UPDATE players SET doc = ? WHERE key = ?');
      let before = 0; let after = 0;
      for (const r of rows) {
        const doc = JSON.parse(r.doc) as PlayerDoc;
        const last = mostRecentPosition(doc.positions ?? {});
        if (last) before++;
        doc.positions = last ? { [WORLD_ID]: last } : {};
        if (last) { doc.position = { cellKey: last.cellKey, x: last.x, y: last.y, z: last.z }; after++; }
        write.run(JSON.stringify(doc), r.key);
      }
      log('info', 'players.positions_migrated', { docs: rows.length, before, after });
    },
  },
  {
    // OT3-184: point-in-time restore. A copy of the doc as flushed, at most one per character
    // per SNAPSHOT_EVERY_MS, kept SNAPSHOT_TTL_MS.
    name: '004-snapshots',
    up: (db: DatabaseSync) => {
      db.exec(`CREATE TABLE snapshots (key TEXT NOT NULL, ts INTEGER NOT NULL, doc TEXT NOT NULL,
        PRIMARY KEY (key, ts))`);
    },
  },
];
import { WORLD_ID } from '../gateway/worlds';
import { log } from '../log';
import { timeFlush } from '../metrics';

export interface PlayerAppearanceDoc {
  race: string;
  head: string;
  hair: string;
  isMale: boolean;
  class: string;
  name: string;
  // A birthsign grants permanent abilities (Atronach's absorption, Lady's stat bonus).
  // Optional: a character may legitimately have none, and pre-existing docs have no field.
  birthsign?: string;
  // A CUSTOM class, by content: the id is an engine-minted record (Generated:0x<n>) that no
  // other engine has, so the restore rebuilds it from this. Absent for the stock classes.
  classSpec?: { name: string; description: string; specialization: string; attributes: string[]; majorSkills: string[]; minorSkills: string[] };
  // Lycanthropic FORM. The disease-like half of lycanthropy is an ESM::Spell and already
  // rides the spellbook; the form itself is a flag on NpcStats, so without this a werewolf
  // relogged as a human. Absent means human, so old docs need no migration.
  isWerewolf?: boolean;
  // The spell that grants Vampirism, when the character has one: puppets get that one spell
  // so the vampire head shows on other screens (the spellbook reaches only the avatar).
  vampireSpell?: string;
}

// Type alias (not interface) so it structurally satisfies JsLike's index signature.
export type DynamicStatDoc = {
  c: number;
  b: number;
};

export type ItemStateDoc = { n?: number; condition?: number; charge?: number; soul?: string; own?: true };

export interface PlayerDoc {
  appearance?: PlayerAppearanceDoc;
  equipment?: Record<number, string>; // slot -> recordId (keys stringify in JSON; normalized on load)
  inventory?: { id: string; n: number }[];
  // Per-item state the record id cannot express: wear, remaining enchantment charge, and
  // which soul is in a gem. Keyed by record id, positional within it, and ADVISORY -- the
  // counts above remain the authority on how much a character owns, so a wrong state costs
  // fidelity and never an item. Without this, every relog silently repaired all gear,
  // recharged every enchantment and emptied every soul gem.
  // One entry PER STACK (#234), in inventory order, each carrying its stack size `n` so the
  // walk stays aligned when a stack has no state at all ({n} alone). `own` marks a record
  // whose wear only the client can author (lockpick/probe/repair uses, torch burn: #233) --
  // the peer's copy never depletes and must not refill it.
  itemStates?: Record<string, ItemStateDoc[]>;
  stats?: {
    dynamic?: { hp: DynamicStatDoc; mp: DynamicStatDoc; ft: DynamicStatDoc };
    attributes?: Record<string, number>;
    skills?: Record<string, number>;
    level?: number;
    reputation?: number; // 0..255, NpcStats-only in the engine: nothing else carries it across a relog
  };
  spells?: string[];
  // The Mark spell's spot: the engine's serialized cell id and a position. Lives in NpcStats
  // only, so without this Recall did nothing after a relog. One per character, not per world:
  // a cell the current world lacks never resolves, which is vanilla's "no mark" answer.
  mark?: { cell: string; x: number; y: number; z: number };
  position?: { cellKey: string; x: number; y: number; z: number };
  // Keyed by world id for the wire/launcher, but ONE WORLD (OT3-41): a flush keeps only this
  // world's entry, and a load takes the most recent one. `position` is the materialized view.
  positions?: Record<string, { cellKey: string; x: number; y: number; z: number; at?: string }>;
  // M6: this player's own view. Always written (even in shared mode, so a family can be
  // switched to individual later without losing history); relayed only per [sharing].
  journal?: Record<string, number>; // questId -> highest index this player reported
  // Backlog 257: the entries in the order they were earned, stamped with the world clock
  // (d = dayspassed, m = month, dm = day of month), so a relog rebuilds a dated journal
  // instead of one entry per quest all dated today. Capped; the map above stays the truth.
  journalLog?: { q: string; i: number; d: number; m: number; dm: number }[];
  // Backlog 260: exterior cells this character (or the campaign, when the map is shared)
  // has discovered, replayed on the welcome so the world map survives a relog.
  explored?: string[];
  /** OT3-108: hours this character has rested/waited past the shared clock. Its own sky runs
   *  this far ahead of the world's; the world's clock never moves for a rest. */
  timeOffsetHours?: number;
  // Phase 4: character-shadowed mwscript globals — quest progress variables that must NOT
  // travel between players (see quests.ts WORLD_GLOBALS). Restored on join/world-hop.
  globals?: Record<string, number>;
  // Backlog 219: the campaign's running global scripts (Sleepers, VampireCheck...), started
  // again at join. Owned by journalTarget like the journal.
  scripts?: string[];
  // Backlog 51: dialogue topics learned, re-added at join (a topic is journal knowledge and
  // follows the journal's doc). Capped; never unlearned.
  topics?: string[];
  // OT3-155: how NPCs feel about THIS character after a conversation (bribe, admire, taunt),
  // by content-ref key, with the cell to replay it in. Capped (quests.ts MAX_DISPOSITIONS).
  dispositions?: Record<string, { cellKey: string; d: number }>;
  // OT3-113: this character's NPC script locals (a quest flag kept in an NPC's local var):
  // cellKey -> content-ref key -> var name -> value. Replayed in WorldCellState to them alone.
  memberVars?: Record<string, Record<string, Record<string, number>>>;
  // Backlog 230: content-ref keys of the NPCs this character has talked to (TalkedToPc).
  talkedTo?: string[];
  // OT3-16: skill books read (NpcStats used ids), flagged again at join so none teaches twice.
  usedBooks?: string[];
  factions?: Record<string, { rank: number; reputation?: number; expelled?: boolean }>;
  bounty?: number;
  // OT3-51: this character's GetDeadCount, per base recordId (worldstate.ts ActorDeath).
  kills?: Record<string, number>;
  // OT3-174: temples and shrines this character has entered, where they arrived, and the
  // outdoor spot they walked in from (ex/ey; absent when they came from another interior
  // before ever being outside). Respawn picks the nearest. Most recent last, capped.
  shrines?: { cellKey: string; x: number; y: number; z: number; ex?: number; ey?: number }[];
}

type LivePosition = { cellKey: string; x: number; y: number; z: number };

const SWEEP_MS = 45_000;
const ERASED_TTL_MS = 90 * 24 * 3_600_000; // backlog 196: erased tombstones older than this are dropped at boot
const EQUIP_DEBOUNCE_MS = 10_000;
const SNAPSHOT_EVERY_MS = 10 * 60_000; // OT3-184: restore granularity
const SNAPSHOT_TTL_MS = 7 * 24 * 3_600_000;

/** The player's latest known position across all worlds — by `at` when the entries carry it,
 *  else the last one written. Seeds a world they have never visited; see materializePosition. */
function mostRecentPosition(
  positions: Record<string, { cellKey: string; x: number; y: number; z: number; at?: string }>,
): { cellKey: string; x: number; y: number; z: number } | undefined {
  let best: { cellKey: string; x: number; y: number; z: number; at?: string } | undefined;
  for (const p of Object.values(positions)) {
    if (!p || typeof p.cellKey !== 'string' || p.cellKey === '') continue;
    if (!best || (p.at ?? '') >= (best.at ?? '')) best = p;
  }
  return best;
}

/**
 * Name, level and last cell of each character, for the dashboard's account list.
 *
 * Straight off disk and never through a PlayerStore: the worlds write these docs from other
 * processes, and a second store's cache and sweep could write a stale copy back. json_extract
 * keeps inventories and journals in SQLite rather than parsing every doc whole.
 */
// THE MAXIMUMS FOLLOW FROM THE ATTRIBUTES, so a saved base that does not was written by
// something other than the character: before 1.7.14 the client sent its BOOT TEMPLATE's bars
// in the seconds before the rejoin record landed (identity.lua, dynamic was not behind
// baselineReady), and prod "Control", an Orc with Str 55 / End 60, came back 35/35 health
// and 30/50 magicka. Repaired from what the engine itself derives:
//   fatigue = Str + Wil + Agi + End (creaturestats.cpp setAttribute)
//   health  = floor((Str + End) / 2) at level 1 (npcstats.cpp updateHealth; levels add to it)
//   magicka = Int x (1 + race/birthsign Fortify Maximum Magicka), in 0.5 steps up to 5x
const MAGICKA_BONUS: Record<string, number> = { breton: 0.5, 'high elf': 1.5, fay: 0.5, elfborn: 1.5, wombburned: 2 };
export function repairBases(doc: PlayerDoc): void {
  const dyn = doc.stats?.dynamic, a = doc.stats?.attributes;
  if (!dyn || !a) return;
  const at = (id: string) => typeof a[id] === 'number' ? Math.max(0, a[id] - (a[`${id}_damage`] ?? 0)) : undefined;
  const str = at('strength'), end = at('endurance'), wil = at('willpower'), agi = at('agility');
  if (dyn.ft && str !== undefined && end !== undefined && wil !== undefined && agi !== undefined) dyn.ft.b = str + wil + agi + end;
  // ponytail: health is only exact at level 1; past it the gains depend on Endurance at each level-up.
  const sb = a.strength, eb = a.endurance;
  if (dyn.hp && doc.stats?.level === 1 && typeof sb === 'number' && typeof eb === 'number') dyn.hp.b = Math.floor((sb + eb) / 2);
  const int = at('intelligence');
  if (dyn.mp && int !== undefined && int > 0) {
    const m = dyn.mp.b / int;
    const onStep = m >= 1 - 1 / int && m <= 5 + 1 / int && Math.abs(m * 2 - Math.round(m * 2)) * int <= 2;
    if (!onStep) {
      const bonus = (MAGICKA_BONUS[doc.appearance?.race?.toLowerCase() ?? ''] ?? 0) + (MAGICKA_BONUS[doc.appearance?.birthsign?.toLowerCase() ?? ''] ?? 0);
      dyn.mp.b = Math.floor(int * (1 + bonus));
    }
  }
}

export function readCharacterCards(dataDir: string, keys: string[]):
  Map<string, { name?: string; level?: number; cell?: string }> {
  const out = new Map<string, { name?: string; level?: number; cell?: string }>();
  const path = join(dataDir, 'players.db');
  if (keys.length === 0 || !existsSync(path)) return out;
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const q = db.prepare(`SELECT json_extract(doc, '$.appearance.name') AS name,
      json_extract(doc, '$.stats.level') AS level, json_extract(doc, '$.positions') AS positions,
      json_extract(doc, '$.position.cellKey') AS cell FROM players WHERE key = ?`);
    for (const key of keys) {
      const r = q.get(key) as { name: string | null; level: number | null; positions: string | null;
        cell: string | null } | undefined;
      if (!r) continue;
      const latest = r.positions ? mostRecentPosition(JSON.parse(r.positions)) : undefined;
      out.set(key, { name: r.name ?? undefined, level: r.level ?? undefined, cell: latest?.cellKey ?? r.cell ?? undefined });
    }
  } catch (err) {
    log('warn', 'playerstore.cards_failed', { error: String(err) });
  } finally {
    db.close();
  }
  return out;
}

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

  suppressSaves(key: string): void {
    this.creating.add(key);
    // A new character under this key: whatever was erased before is not this one.
    try { this.db.prepare('DELETE FROM erased WHERE key = ?').run(key); } catch { /* best effort */ }
  }
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
    // Backlog 196: a tombstone only has to outlive any sweep that could still rewrite the
    // row (seconds); 90 days is generous, and without this the table grows forever.
    try { this.db.prepare('DELETE FROM erased WHERE at < ?').run(Date.now() - ERASED_TTL_MS); } catch { /* best effort */ }
    // ponytail: pruned at boot only; a server up for weeks keeps older rows until it restarts.
    try { this.db.prepare('DELETE FROM snapshots WHERE ts < ?').run(Date.now() - SNAPSHOT_TTL_MS); } catch { /* best effort */ }
    this.sweepTimer = setInterval(() => {
      void this.flushAll();
    }, SWEEP_MS);
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
      this.db.prepare('DELETE FROM snapshots WHERE key = ?').run(key); // OT3-184: erasure means the history too
      this.db.prepare('INSERT OR REPLACE INTO erased (key, at) VALUES (?, ?)').run(key, Date.now());
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
    // A bar above its max is a 1.7.13 leftover (a base-only restore left current where it
    // was: prod "Control" saved magicka 50/30). Active spells are not saved, so no Fortify
    // survives a relog to explain it; cap it here, the one door every reader comes through.
    const dyn = loaded.stats?.dynamic;
    if (dyn) repairBases(loaded);
    if (dyn) for (const d of [dyn.hp, dyn.mp, dyn.ft]) if (d && d.c > d.b) d.c = d.b;
    this.materializePosition(loaded);
    this.cache.set(key, loaded);
    return loaded;
  }

  // One world (OT3-41): the position is where the character last stood, whatever world key
  // wrote it. No entry at all leaves the default spawn.
  private materializePosition(doc: PlayerDoc): void {
    if (!doc.positions) return;
    const last = doc.positions[this.worldId] ?? mostRecentPosition(doc.positions);
    // The `at` stamp is the map's, not the pose's: it must not ride into the Welcome.
    if (last) doc.position = { cellKey: last.cellKey, x: last.x, y: last.y, z: last.z };
    else delete doc.position;
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
    // NOT `dirty.delete(key)`: an update() that landed DURING the await above set the flag
    // again, and clearing it here would discard that write entirely (the doc is evicted from
    // cache on the next line, so there is no second chance). flushKey already clears the flag
    // for what it actually wrote; anything still marked dirty is newer than the flush and
    // must survive to the sweep.
    if (!this.dirty.has(key)) this.cache.delete(key);
    this.creating.delete(key);
    // The sim-peer flag is per-connection state too. clearEphemeral existed for this and was
    // never called anywhere, so a key stayed ephemeral for the life of the process.
    this.ephemeral.delete(key);
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
    await timeFlush('players', async () => this.writeKey(key));
  }

  private writeKey(key: string): void {
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
    if (this.erased(key)) {
      // Deleted from another process while this one still held it: not ours to bring back.
      this.cache.delete(key);
      log('info', 'players.flush_dropped_erased', { player: key });
      return;
    }
    const live = this.livePosition(key);
    if (live) doc.position = { ...live };
    // One entry (OT3-41): the position replaces the map rather than joining it.
    // STAMPED, because "where you last stood" needs to know WHEN. Seeding a world you have
    // never visited picks the most recent entry, and with no timestamp that silently degraded
    // to object insertion order — which does NOT move when an existing key is rewritten, so a
    // player with several worlds could be seeded from the oldest one they had ever entered.
    if (doc.position) {
      doc.positions = { [this.worldId]: { ...doc.position, at: new Date().toISOString() } };
    }
    try {
      const json = JSON.stringify(doc);
      this.db.prepare('INSERT OR REPLACE INTO players (key, doc) VALUES (?, ?)').run(key, json);
      this.maybeSnapshot(key, json);
    } catch (err) {
      this.dirty.add(key); // retry on the next flush point
      log('error', 'players.flush_failed', { player: key, error: String(err) });
    }
  }

  // OT3-184: one snapshot per character per SNAPSHOT_EVERY_MS, taken from what was just flushed.
  private lastSnapshot = new Map<string, number>();
  private maybeSnapshot(key: string, json: string, now = this.now()): void {
    let last = this.lastSnapshot.get(key);
    if (last === undefined) {
      const row = this.db.prepare('SELECT MAX(ts) AS ts FROM snapshots WHERE key = ?').get(key) as { ts: number | null };
      last = row.ts ?? 0;
    }
    if (now - last < SNAPSHOT_EVERY_MS) return;
    try {
      this.db.prepare('INSERT OR REPLACE INTO snapshots (key, ts, doc) VALUES (?, ?, ?)').run(key, now, json);
      this.lastSnapshot.set(key, now);
    } catch (err) {
      log('warn', 'players.snapshot_failed', { player: key, error: String(err) });
    }
  }
  /** Test seam for the snapshot clock. */
  now: () => number = Date.now;

  /** Replace a character with its newest snapshot at or before `at`. The current doc is
   *  snapshotted first, so a restore can itself be undone. The caller disconnects the
   *  character BEFORE this: a live client would write its state straight back.
   *  Returns the snapshot's time, or undefined when there is none that old. */
  restoreTo(key: string, at: number): number | undefined {
    const row = this.db.prepare('SELECT ts, doc FROM snapshots WHERE key = ? AND ts <= ? ORDER BY ts DESC LIMIT 1')
      .get(key, at) as { ts: number; doc: string } | undefined;
    if (!row) return undefined;
    const current = this.db.prepare('SELECT doc FROM players WHERE key = ?').get(key) as { doc: string } | undefined;
    if (current) {
      this.db.prepare('INSERT OR REPLACE INTO snapshots (key, ts, doc) VALUES (?, ?, ?)').run(key, this.now(), current.doc);
      this.lastSnapshot.set(key, this.now());
    }
    this.db.prepare('INSERT OR REPLACE INTO players (key, doc) VALUES (?, ?)').run(key, row.doc);
    // Drop what this process held, so the next read (the rejoin) comes off disk.
    this.cache.delete(key);
    this.dirty.delete(key);
    const pending = this.debounce.get(key);
    if (pending) { clearTimeout(pending); this.debounce.delete(key); }
    this.loadSync(key);
    return row.ts;
  }

  // OT3-87: a sweep reads the tombstones once instead of one SELECT per doc.
  private erasedSet?: Set<string>;
  private erased(key: string): boolean {
    if (this.erasedSet) return this.erasedSet.has(key);
    try { return this.db.prepare('SELECT 1 FROM erased WHERE key = ?').get(key) !== undefined; }
    catch { return false; }
  }

  async flushAll(): Promise<void> {
    // OT3-92: one transaction per sweep (see CellStore.flushAll).
    const keys = [...this.dirty];
    try {
      this.erasedSet = new Set((this.db.prepare('SELECT key FROM erased').all() as { key: string }[]).map((r) => r.key));
      await timeFlush('players', async () => tx(this.db, () => { for (const key of keys) this.writeKey(key); }));
    } catch (err) {
      for (const key of keys) this.dirty.add(key); // rolled back: every key is unwritten again
      log('error', 'players.sweep_failed', { error: String(err) });
    } finally {
      this.erasedSet = undefined;
    }
    checkpoint(this.db); // so a backup tarred after SIGUSR1 sees one file, not db+wal+shm
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
