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
import { join } from 'node:path';

// Keys are ACCOUNT keys, never player ids: player ids are per-session, so an id-keyed
// friendship would expire on every reconnect.
export type AccountKey = string;

export interface FriendRow {
  account: AccountKey;
  since: number;
}

export class SocialStore {
  private readonly db: DatabaseSync;

  // ':memory:' is accepted for tests.
  constructor(dataDir: string, filename = 'social.sqlite') {
    this.db = new DatabaseSync(dataDir === ':memory:' ? ':memory:' : join(dataDir, filename));
    // WAL: a crash mid-write must not take the graph with it. Also lets a read (the
    // FriendList sent on join) proceed while a write is in flight.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
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
      -- Presence mode is a per-account PREFERENCE, so it persists; party membership is
      -- session state and deliberately does not (see social.ts).
      CREATE TABLE IF NOT EXISTS presence_pref (
        account TEXT PRIMARY KEY,
        mode    TEXT NOT NULL
      );
    `);
  }

  close(): void {
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

  friendsOf(account: AccountKey): FriendRow[] {
    const rows = this.db
      .prepare('SELECT a, b, since FROM friend WHERE a = ? OR b = ? ORDER BY since')
      .all(account, account) as { a: string; b: string; since: number }[];
    return rows.map((r) => ({ account: r.a === account ? r.b : r.a, since: r.since }));
  }

  addFriend(x: AccountKey, y: AccountKey, now: number): void {
    if (x === y) return; // self-friendship is meaningless and would violate CHECK(a < b)
    const [a, b] = SocialStore.pair(x, y);
    this.db.prepare('INSERT OR IGNORE INTO friend (a, b, since) VALUES (?, ?, ?)').run(a, b, now);
  }

  removeFriend(x: AccountKey, y: AccountKey): void {
    const [a, b] = SocialStore.pair(x, y);
    this.db.prepare('DELETE FROM friend WHERE a = ? AND b = ?').run(a, b);
  }

  // ------------------------------------------------------------------- blocks

  // Directional by nature: A blocking B is not B blocking A.
  addBlock(blocker: AccountKey, blocked: AccountKey, now: number): void {
    if (blocker === blocked) return;
    this.db.prepare('INSERT OR IGNORE INTO block (blocker, blocked, since) VALUES (?, ?, ?)')
      .run(blocker, blocked, now);
  }

  removeBlock(blocker: AccountKey, blocked: AccountKey): void {
    this.db.prepare('DELETE FROM block WHERE blocker = ? AND blocked = ?').run(blocker, blocked);
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
    this.db
      .prepare('INSERT OR REPLACE INTO friend_request (fromAcct, toAcct, sent, expires) VALUES (?, ?, ?, ?)')
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
    this.db.prepare('DELETE FROM friend_request WHERE fromAcct = ? AND toAcct = ?').run(from, to);
  }

  pendingFor(to: AccountKey, now: number): AccountKey[] {
    return (this.db
      .prepare('SELECT fromAcct FROM friend_request WHERE toAcct = ? AND expires > ? ORDER BY sent')
      .all(to, now) as { fromAcct: string }[]).map((r) => r.fromAcct);
  }

  // Outstanding requests SENT by an account, used to cap them — without a cap this is a
  // spam channel that costs the sender nothing.
  outstandingFrom(from: AccountKey, now: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM friend_request WHERE fromAcct = ? AND expires > ?')
      .get(from, now) as { n: number };
    return row.n;
  }

  // ------------------------------------------------------------ presence mode

  getPresenceMode(account: AccountKey): string | undefined {
    const row = this.db.prepare('SELECT mode FROM presence_pref WHERE account = ?').get(account) as
      { mode: string } | undefined;
    return row?.mode;
  }

  setPresenceMode(account: AccountKey, mode: string): void {
    this.db.prepare('INSERT OR REPLACE INTO presence_pref (account, mode) VALUES (?, ?)').run(account, mode);
  }

  sweepExpired(now: number): number {
    const before = this.db.prepare('SELECT COUNT(*) AS n FROM friend_request').get() as { n: number };
    this.db.prepare('DELETE FROM friend_request WHERE expires <= ?').run(now);
    const after = this.db.prepare('SELECT COUNT(*) AS n FROM friend_request').get() as { n: number };
    return before.n - after.n;
  }
}
