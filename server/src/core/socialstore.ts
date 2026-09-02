// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase C persistence: the friends graph, blocks and pending friend requests.
//
// This is the first relational data in the project and the first departure from the
// per-entity JSON stores, which is deliberate and narrow. "Who are my friends" against
// per-entity files means reading every file, and a mutation that touches two files can be
// interrupted halfway; a graph wants a database. Everything already working — cell docs,
// player docs, accounts — stays JSON, because rewriting persistence that a 30-minute soak
// proves clean buys nothing.
//
// node:sqlite is only the right answer because the world is SINGLE-PROCESS (see
// docs/PHASE-C-SOCIAL.md). If the map is ever region-sharded across processes, social data
// has to move to a shared service first — a friend online in another process cannot be
// expressed by a file this process owns.

import { DatabaseSync } from 'node:sqlite';
import { openDb, type Migration } from '../persist/sqlite';
import { join } from 'node:path';

// Phase W (multiplayer912026): the party concept is deleted — every player owns a world and
// guests simply join it. Live servers carry party rows, so this is a MIGRATION, not a schema
// edit: it runs once, recorded in schema_migrations, in its own transaction.
//
// Existence-guarded because openDb runs migrations BEFORE migrate() creates the base tables,
// so on a fresh database these tables do not exist yet and there is nothing to rewrite.
const SOCIAL_MIGRATIONS: Migration[] = [
  {
    name: 'w1-solo-party',
    up: (db: DatabaseSync) => {
      const has = (t: string): boolean => db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
        .get(t) !== undefined;
      // Party chat scrollback: the scope was the party id, and the party — the only thing
      // that could ever read it back — is gone. Server-wide scope ('') survives; from now on
      // non-empty scopes are WORLD ids.
      if (has('chat_history')) db.exec("DELETE FROM chat_history WHERE scope <> ''");
      // Invites collapse to one kind: a party invite has nothing left to accept into.
      if (has('invite')) db.exec("DELETE FROM invite WHERE kind = 'party'");
      // The 'party' presence-privacy mode is gone; 'friends' is the nearest survivor.
      if (has('presence_pref')) db.exec("UPDATE presence_pref SET mode = 'friends' WHERE mode = 'party'");
      db.exec('DROP TABLE IF EXISTS party_setting');
      db.exec('DROP TABLE IF EXISTS party_member');
      db.exec('DROP TABLE IF EXISTS party');
    },
  },
];

// Keys are ACCOUNT keys, never player ids: player ids are per-session, so an id-keyed
// friendship would expire on every reconnect.
export type AccountKey = string;

export interface ChatHistoryRow {
  ts: number;
  channel: string;
  acct: AccountKey;
  name: string;
  text: string;
}

export interface PresenceRow {
  account: AccountKey;
  world: string;
  name: string;
  cellKey?: string;
  isBot: boolean;
}

export interface FriendRow {
  account: AccountKey;
  since: number;
}

// How far back a sweep looks for departures. Wider than any plausible gap between two
// heartbeats, so a disconnect cannot slip through, and narrow enough that the scan does not
// grow with the lifetime of the server.
const SWEEP_WINDOW_MS = 60 * 60 * 1000;
// A presence row nobody has refreshed in this long belongs to a world process that died
// without cleaning up.
const PRESENCE_DEAD_MS = 5 * 60 * 1000;
// How long an offline row is kept before it is deleted outright.
const PRESENCE_KEEP_MS = 24 * 60 * 60 * 1000;

export class SocialStore {
  private readonly db: DatabaseSync;

  // ':memory:' is accepted for tests.
  constructor(dataDir: string, filename = 'social.sqlite') {
    if (dataDir === ':memory:') {
      this.db = new DatabaseSync(':memory:');
      this.db.exec('PRAGMA foreign_keys = ON');
    } else {
      // THROUGH openDb, LIKE EVERY OTHER STORE. This was the one SQLite user in the repo that
      // opened its own handle, and so the one WITHOUT `PRAGMA busy_timeout` — while being the
      // only database genuinely shared by every world process. WAL admits a single writer, so
      // N worlds writing presence on a 10s heartbeat make SQLITE_BUSY a matter of when; with
      // no busy_timeout that is an instant throw instead of a short wait, and it surfaced
      // inside a setInterval where an uncaughtException kills the whole world process.
      //
      // The header comment above still says node:sqlite is safe because a world is
      // single-process. That stopped being true when the gateway started spawning one process
      // per world; this line is the correction.
      this.db = openDb(join(dataDir, filename), SOCIAL_MIGRATIONS);
    }
    this.migrate();
  }

  private migrate(): void {
    // One row per PAIR with a < b enforced by CHECK. Two rows per friendship allows a
    // half-applied mutation to leave A friends with B while B is not friends with A, and
    // then every read has to decide which direction is authoritative.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS friend (
        a     TEXT NOT NULL,
        b     TEXT NOT NULL,
        since INTEGER NOT NULL,
        PRIMARY KEY (a, b),
        CHECK (a < b)
      );
      CREATE TABLE IF NOT EXISTS block (
        blocker TEXT NOT NULL,
        blocked TEXT NOT NULL,
        since   INTEGER NOT NULL,
        PRIMARY KEY (blocker, blocked)
      );
      CREATE TABLE IF NOT EXISTS friend_request (
        fromAcct TEXT NOT NULL,
        toAcct   TEXT NOT NULL,
        sent     INTEGER NOT NULL,
        expires  INTEGER NOT NULL,
        PRIMARY KEY (fromAcct, toAcct)
      );
      CREATE INDEX IF NOT EXISTS friend_request_to ON friend_request(toAcct);
      -- World invites, persisted for the SAME reason friend requests are: worlds are
      -- separate processes, so an in-memory invite could only ever reach someone already in
      -- the sender's world. That made "invite your friend" work exactly when you did not
      -- need it. One row per (from, to): re-inviting refreshes rather than stacking.
      CREATE TABLE IF NOT EXISTS invite (
        fromAcct TEXT NOT NULL,
        toAcct   TEXT NOT NULL,
        kind     TEXT NOT NULL, -- always 'world'; the column predates the party removal
        sent     INTEGER NOT NULL,
        expires  INTEGER NOT NULL,
        PRIMARY KEY (fromAcct, toAcct)
      );
      CREATE INDEX IF NOT EXISTS invite_to ON invite(toAcct);
      -- Presence mode is a per-account PREFERENCE, so it persists.
      -- WHO IS ONLINE, SERVER-WIDE. Every world is its own PROCESS with its own roster, so a
      -- world could only ever see its own occupants: a friend playing in their own solo world
      -- read as OFFLINE, a party member elsewhere had no location, and the Players list showed
      -- one world's population as if it were the server's. Presence is therefore shared state,
      -- like friendships and parties, rather than something each process infers alone.
      -- Rows are refreshed on a heartbeat and read with a TTL, so a world that dies without
      -- cleaning up ages out instead of leaving ghosts online forever.
      -- CHAT SCROLLBACK, shared and durable. The client's feed lives in the page, and a world
      -- change now RELOADS the page — so every switch wiped the conversation, and a player
      -- arriving anywhere saw an empty box with no idea what was being discussed. History is
      -- what makes a chat box feel inhabited rather than like a fresh terminal.
      --
      -- Shared, not per-world, for the same reason parties are: the public channel is one
      -- conversation across the whole server, and a player who steps into their own world and
      -- back should not lose it. Trimmed to a bounded tail — this is scrollback, not an
      -- archive; the moderation log is the archive and answers a different question.
      CREATE TABLE IF NOT EXISTS chat_history (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts       INTEGER NOT NULL,
        channel  TEXT NOT NULL,
        scope    TEXT NOT NULL,   -- '' for server-wide; a world id for world-scoped lines
        acct     TEXT NOT NULL,
        name     TEXT NOT NULL,
        text     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_history_scope ON chat_history (scope, id);
      CREATE TABLE IF NOT EXISTS presence (
        account       TEXT PRIMARY KEY,
        world         TEXT NOT NULL,
        name          TEXT NOT NULL,
        cell_key      TEXT,
        is_bot        INTEGER NOT NULL DEFAULT 0,
        updated_at    INTEGER NOT NULL,
        -- WHEN they went, not merely THAT they are gone. Deleting the row on leave made
        -- "offline" and "offline for a while" indistinguishable — and the difference is the
        -- whole question: leaving one world to join another IS a disconnect from the first,
        -- and treating that as quitting would dissolve a party every time someone switched.
        offline_since INTEGER
      );
      CREATE TABLE IF NOT EXISTS presence_pref (
        account TEXT PRIMARY KEY,
        mode    TEXT NOT NULL
      );
      -- Availability (Online/Offline) is a SEPARATE axis from presence: presence is "who may
      -- see my location", availability is "am I reachable + where am I routed". Offline peels
      -- the player into their solo world and hides them from friends' online lists. Persists
      -- so a player who went Offline stays Offline across a reconnect until they choose Online.
      CREATE TABLE IF NOT EXISTS availability_pref (
        account TEXT PRIMARY KEY,
        state   TEXT NOT NULL
      );
      -- Mutes PERSIST: "I muted this person" must survive a relog, or the control is a
      -- suggestion. muter = '@server' is a moderator mute (applies to everyone), which is
      -- why this is one table rather than a per-player list — the lookup is identical.
      CREATE TABLE IF NOT EXISTS mute (
        muter TEXT NOT NULL,
        muted TEXT NOT NULL,
        since INTEGER NOT NULL,
        PRIMARY KEY (muter, muted)
      );
      CREATE INDEX IF NOT EXISTS mute_muter ON mute(muter);
    `);

    // COLUMNS ADDED TO AN EXISTING TABLE. `CREATE TABLE IF NOT EXISTS` above is a no-op on a
    // database that already has the table, so a new column never appears on a live server —
    // the code compiles, every test passes against a fresh temp dir, and production is the
    // only place that breaks. Add it explicitly; SQLite throws if it is already there.
    for (const [table, column, decl] of [
      ['presence', 'offline_since', 'INTEGER'],
    ] as const) {
      const has = (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
        .some((c) => c.name === column);
      if (!has) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }

  // CLOSED IS A STATE, NOT A CLIFF. Social handlers await network work mid-flight (PartyTravel
  // waits on the gateway's world list with a 3s timeout), so a shutdown that begins during one
  // of those resumes into a synchronous write against a closed handle — which throws from a
  // detached promise nobody is awaiting. There are 29 write sites; guarding the STORE is one
  // change instead of 29, and "the server is going away" is the store's business, not each
  // caller's.
  private closed = false;

  // Every mutation routes through here, so the closed check exists once.
  private write(sql: string): { run: (...a: unknown[]) => unknown } {
    if (this.closed) return { run: () => undefined };
    return this.db.prepare(sql) as unknown as { run: (...a: unknown[]) => unknown };
  }

  /** True once close() has run. Writes after this point are dropped, not thrown. */
  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // Pair ordering is applied in ONE place so no caller can accidentally insert (b, a).
  private static pair(x: AccountKey, y: AccountKey): [AccountKey, AccountKey] {
    return x < y ? [x, y] : [y, x];
  }

  // ------------------------------------------------------------------ friends

  areFriends(x: AccountKey, y: AccountKey): boolean {
    const [a, b] = SocialStore.pair(x, y);
    return this.db.prepare('SELECT 1 FROM friend WHERE a = ? AND b = ?').get(a, b) !== undefined;
  }

  // --- chat scrollback ------------------------------------------------------------------

  /** Append one line and trim the tail. Called for the channels a newcomer may replay. */
  appendChat(line: { ts: number; channel: string; scope: string; acct: string; name: string; text: string },
    keep: number): void {
    this.write(
      'INSERT INTO chat_history (ts, channel, scope, acct, name, text) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(line.ts, line.channel, line.scope, line.acct, line.name, line.text);
    // Bounded per scope, so a busy public channel cannot push a quiet party's history out.
    this.write(
      `DELETE FROM chat_history WHERE scope = ? AND id NOT IN
         (SELECT id FROM chat_history WHERE scope = ? ORDER BY id DESC LIMIT ?)`,
    ).run(line.scope, line.scope, keep);
  }

  /** Oldest-first tail for a scope, so a client can replay it in the order it was said. */
  recentChat(scope: string, limit: number): ChatHistoryRow[] {
    const rows = this.db.prepare(
      'SELECT ts, channel, acct, name, text FROM chat_history WHERE scope = ? ORDER BY id DESC LIMIT ?',
    ).all(scope, limit) as unknown as ChatHistoryRow[];
    return rows.reverse();
  }

  // --- server-wide presence -----------------------------------------------------------
  // A world writes its own occupants here and reads everyone's. See the presence table.

  /** Refresh this account's presence. Called on join and on the heartbeat. */
  setPresence(account: AccountKey, world: string, name: string,
    cellKey: string | undefined, isBot: boolean, now: number): void {
    this.write(
      `INSERT INTO presence (account, world, name, cell_key, is_bot, updated_at, offline_since)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(account) DO UPDATE SET
         world = excluded.world, name = excluded.name, cell_key = excluded.cell_key,
         is_bot = excluded.is_bot, updated_at = excluded.updated_at, offline_since = NULL`,
    ).run(account, world, name, cellKey ?? null, isBot ? 1 : 0, now);
  }

  /** Drop presence on leave. Deleting only OUR row matters: a player who moved to another
   *  world has already written a row naming that world, and a late delete from the world they
   *  left would wrongly mark them offline. */
  clearPresence(account: AccountKey, world: string, now: number): void {
    // Marked, not deleted: a party sweep has to know how LONG someone has been gone, and a
    // missing row cannot say. Reads still treat it as offline immediately.
    this.write(
      'UPDATE presence SET offline_since = ? WHERE account = ? AND world = ? AND offline_since IS NULL',
    ).run(now, account, world);
  }

  /** Accounts that have been offline EVERYWHERE for longer than `graceMs`. The grace is what
   *  separates a world switch from quitting. */
  goneLongerThan(now: number, graceMs: number): AccountKey[] {
    const cutoff = now - graceMs;
    // A LOWER BOUND AS WELL AS AN UPPER ONE. Nothing deletes presence rows — clearPresence
    // only stamps offline_since — so without a floor this matched every account that has ever
    // played, forever, and the caller ran a party lookup per row every 10 seconds in every
    // world process. The window only has to be wide enough that a departure cannot be missed
    // between two sweeps; anything older has already been handled.
    const floor = cutoff - SWEEP_WINDOW_MS;
    const rows = this.db.prepare(
      'SELECT account FROM presence WHERE offline_since IS NOT NULL'
      + ' AND offline_since <= ? AND offline_since > ?',
    ).all(cutoff, floor) as { account: string }[];
    // A world process that dies HARD never runs clearPresence, so its occupants keep
    // offline_since NULL with a frozen updated_at: they are hidden from presentEverywhere by
    // the TTL, but the sweep never fired for them and their party survived until the 24h
    // staleness. A row nobody has refreshed in far longer than the heartbeat is gone.
    const stale = this.db.prepare(
      'SELECT account FROM presence WHERE offline_since IS NULL AND updated_at <= ? AND updated_at > ?',
    ).all(cutoff - PRESENCE_DEAD_MS, floor - PRESENCE_DEAD_MS) as { account: string }[];
    return [...new Set([...rows, ...stale].map((r) => r.account))];
  }

  /** Delete presence rows for accounts long gone. Called from the same heartbeat as the sweep;
   *  without it the table grows by one row per account that ever played and never shrinks. */
  prunePresence(now: number): number {
    const res = this.write('DELETE FROM presence WHERE offline_since IS NOT NULL AND offline_since <= ?')
      .run(now - PRESENCE_KEEP_MS) as { changes?: number } | undefined;
    return Number(res?.changes ?? 0);
  }

  /** Everyone online across every world, fresher than `ttlMs`. */
  presentEverywhere(now: number, ttlMs: number): PresenceRow[] {
    const rows = this.db.prepare(
      'SELECT account, world, name, cell_key AS cellKey, is_bot AS isBot FROM presence'
      + ' WHERE offline_since IS NULL AND updated_at >= ?',
    ).all(now - ttlMs) as { account: string; world: string; name: string; cellKey: string | null; isBot: number }[];
    return rows.map((r) => ({
      account: r.account, world: r.world, name: r.name,
      cellKey: r.cellKey ?? undefined, isBot: r.isBot === 1,
    }));
  }

  friendsOf(account: AccountKey): FriendRow[] {
    const rows = this.db
      .prepare('SELECT a, b, since FROM friend WHERE a = ? OR b = ? ORDER BY since')
      .all(account, account) as { a: string; b: string; since: number }[];
    return rows.map((r) => ({ account: r.a === account ? r.b : r.a, since: r.since }));
  }

  addFriend(x: AccountKey, y: AccountKey, now: number): void {
    if (x === y) return; // self-friendship is meaningless and would violate CHECK(a < b)
    const [a, b] = SocialStore.pair(x, y);
    this.write('INSERT OR IGNORE INTO friend (a, b, since) VALUES (?, ?, ?)').run(a, b, now);
  }

  removeFriend(x: AccountKey, y: AccountKey): void {
    const [a, b] = SocialStore.pair(x, y);
    this.write('DELETE FROM friend WHERE a = ? AND b = ?').run(a, b);
  }

  // ------------------------------------------------------------------- blocks

  // Directional by nature: A blocking B is not B blocking A.
  addBlock(blocker: AccountKey, blocked: AccountKey, now: number): void {
    if (blocker === blocked) return;
    this.write('INSERT OR IGNORE INTO block (blocker, blocked, since) VALUES (?, ?, ?)')
      .run(blocker, blocked, now);
  }

  removeBlock(blocker: AccountKey, blocked: AccountKey): void {
    this.write('DELETE FROM block WHERE blocker = ? AND blocked = ?').run(blocker, blocked);
  }

  // EITHER direction counts. A block must suppress interaction both ways, or the blocked
  // party still sees presence and can still be invited by the person who blocked them —
  // and can trivially re-establish contact.
  blockedEitherWay(x: AccountKey, y: AccountKey): boolean {
    return this.db
      .prepare('SELECT 1 FROM block WHERE (blocker = ? AND blocked = ?) OR (blocker = ? AND blocked = ?)')
      .get(x, y, y, x) !== undefined;
  }

  blockedBy(blocker: AccountKey): AccountKey[] {
    return (this.db.prepare('SELECT blocked FROM block WHERE blocker = ?').all(blocker) as { blocked: string }[])
      .map((r) => r.blocked);
  }

  // ----------------------------------------------------------------- requests

  addRequest(from: AccountKey, to: AccountKey, now: number, ttlMs: number): void {
    this
      .write('INSERT OR REPLACE INTO friend_request (fromAcct, toAcct, sent, expires) VALUES (?, ?, ?, ?)')
      .run(from, to, now, now + ttlMs);
  }

  // Expiry is enforced on READ as well as by the sweep: a request that outlived its TTL
  // must not be acceptable just because the sweep has not run yet.
  hasRequest(from: AccountKey, to: AccountKey, now: number): boolean {
    return this.db
      .prepare('SELECT 1 FROM friend_request WHERE fromAcct = ? AND toAcct = ? AND expires > ?')
      .get(from, to, now) !== undefined;
  }

  removeRequest(from: AccountKey, to: AccountKey): void {
    this.write('DELETE FROM friend_request WHERE fromAcct = ? AND toAcct = ?').run(from, to);
  }

  pendingFor(to: AccountKey, now: number): AccountKey[] {
    return (this.db
      .prepare('SELECT fromAcct FROM friend_request WHERE toAcct = ? AND expires > ? ORDER BY sent')
      .all(to, now) as { fromAcct: string }[]).map((r) => r.fromAcct);
  }

  /** Every account this one has an outstanding request TO. One query instead of one per
   *  candidate — see Social.relationsFor. */
  sentTo(from: AccountKey, now: number): AccountKey[] {
    return (this.db
      .prepare('SELECT toAcct FROM friend_request WHERE fromAcct = ? AND expires > ?')
      .all(from, now) as { toAcct: string }[]).map((r) => r.toAcct);
  }

  // Outstanding requests SENT by an account, used to cap them — without a cap this is a
  // spam channel that costs the sender nothing.
  outstandingFrom(from: AccountKey, now: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM friend_request WHERE fromAcct = ? AND expires > ?')
      .get(from, now) as { n: number };
    return row.n;
  }

  // ------------------------------------------------------------------ invites
  // Same contract as requests above, including expiry-on-read.

  addInvite(from: AccountKey, to: AccountKey, kind: string, now: number, ttlMs: number): void {
    this
      .write('INSERT OR REPLACE INTO invite (fromAcct, toAcct, kind, sent, expires) VALUES (?, ?, ?, ?, ?)')
      .run(from, to, kind, now, now + ttlMs);
  }

  invitesFor(to: AccountKey, now: number): { from: AccountKey; kind: string }[] {
    return (this.db
      .prepare('SELECT fromAcct, kind FROM invite WHERE toAcct = ? AND expires > ? ORDER BY sent')
      .all(to, now) as { fromAcct: string; kind: string }[])
      .map((r) => ({ from: r.fromAcct, kind: r.kind }));
  }

  hasInvite(from: AccountKey, to: AccountKey, now: number): boolean {
    return this.db
      .prepare('SELECT 1 FROM invite WHERE fromAcct = ? AND toAcct = ? AND expires > ?')
      .get(from, to, now) !== undefined;
  }

  removeInvite(from: AccountKey, to: AccountKey): void {
    this.write('DELETE FROM invite WHERE fromAcct = ? AND toAcct = ?').run(from, to);
  }

  // ------------------------------------------------------------ presence mode

  getPresenceMode(account: AccountKey): string | undefined {
    const row = this.db.prepare('SELECT mode FROM presence_pref WHERE account = ?').get(account) as
      { mode: string } | undefined;
    return row?.mode;
  }

  setPresenceMode(account: AccountKey, mode: string): void {
    this.write('INSERT OR REPLACE INTO presence_pref (account, mode) VALUES (?, ?)').run(account, mode);
  }

  // ------------------------------------------------------------ availability

  getAvailability(account: AccountKey): string | undefined {
    const row = this.db.prepare('SELECT state FROM availability_pref WHERE account = ?').get(account) as
      { state: string } | undefined;
    return row?.state;
  }

  setAvailability(account: AccountKey, state: string): void {
    this.write('INSERT OR REPLACE INTO availability_pref (account, state) VALUES (?, ?)').run(account, state);
  }

  // --------------------------------------------------------------------- mutes

  static readonly SERVER_MUTER = '@server';

  addMute(muter: AccountKey, muted: AccountKey, now: number): void {
    if (muter === muted) return;
    this.write('INSERT OR IGNORE INTO mute (muter, muted, since) VALUES (?, ?, ?)').run(muter, muted, now);
  }

  removeMute(muter: AccountKey, muted: AccountKey): void {
    this.write('DELETE FROM mute WHERE muter = ? AND muted = ?').run(muter, muted);
  }

  // True when `listener` should not hear/see `speaker`: either they muted them, or a
  // moderator muted the speaker for everyone.
  isMuted(listener: AccountKey, speaker: AccountKey): boolean {
    return this.db
      .prepare('SELECT 1 FROM mute WHERE muted = ? AND (muter = ? OR muter = ?)')
      .get(speaker, listener, SocialStore.SERVER_MUTER) !== undefined;
  }

  mutesOf(muter: AccountKey): AccountKey[] {
    return (this.db.prepare('SELECT muted FROM mute WHERE muter = ? ORDER BY since').all(muter) as
      { muted: string }[]).map((r) => r.muted);
  }

  sweepExpired(now: number): number {
    const count = (t: string): number =>
      (this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const before = count('friend_request') + count('invite');
    this.write('DELETE FROM friend_request WHERE expires <= ?').run(now);
    // Invites expire on the same sweep. Left out, a dead invite sits in the mailbox and is
    // re-delivered on every join — expiry-on-read hides it, but it never goes away.
    this.write('DELETE FROM invite WHERE expires <= ?').run(now);
    return before - (count('friend_request') + count('invite'));
  }
}
