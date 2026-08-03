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
      -- Party/world invites, persisted for the SAME reason friend requests are: worlds are
      -- separate processes, so an in-memory invite could only ever reach someone already in
      -- the sender's world. That made "invite your friend" work exactly when you did not
      -- need it. One row per (from, to): re-inviting refreshes rather than stacking.
      CREATE TABLE IF NOT EXISTS invite (
        fromAcct TEXT NOT NULL,
        toAcct   TEXT NOT NULL,
        kind     TEXT NOT NULL, -- 'party' | 'world'
        sent     INTEGER NOT NULL,
        expires  INTEGER NOT NULL,
        PRIMARY KEY (fromAcct, toAcct)
      );
      CREATE INDEX IF NOT EXISTS invite_to ON invite(toAcct);
      -- Presence mode is a per-account PREFERENCE, so it persists.
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
      -- Party travel: membership PERSISTS (it must survive members hopping between world
      -- processes — the party is a platform-level group, not one world's session state).
      -- The restart-zombie concern that kept parties in memory is handled by updated_at +
      -- partySweepStale: a party nobody has touched for a day dissolves on next load.
      CREATE TABLE IF NOT EXISTS party (
        key        TEXT PRIMARY KEY,
        leader     TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS party_member (
        account TEXT PRIMARY KEY,
        party   TEXT NOT NULL REFERENCES party(key) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS party_member_party ON party_member(party);
      -- Leader-toggled party rules. Persisted with the party so a group's settings survive
      -- the leader hopping worlds (or handing over).
      CREATE TABLE IF NOT EXISTS party_setting (
        party TEXT NOT NULL REFERENCES party(key) ON DELETE CASCADE,
        name  TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (party, name)
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
    this.write('DELETE FROM friend_request WHERE fromAcct = ? AND toAcct = ?').run(from, to);
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

  // ------------------------------------------------------------------ invites
  // Same contract as requests above, including expiry-on-read.

  addInvite(from: AccountKey, to: AccountKey, kind: string, now: number, ttlMs: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO invite (fromAcct, toAcct, kind, sent, expires) VALUES (?, ?, ?, ?, ?)')
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

  // -------------------------------------------------------------------- party

  partyCreate(key: string, leader: AccountKey, now: number): void {
    this.write('INSERT OR REPLACE INTO party (key, leader, updated_at) VALUES (?, ?, ?)').run(key, leader, now);
    this.write('INSERT OR REPLACE INTO party_member (account, party) VALUES (?, ?)').run(leader, key);
  }

  partyOfAccount(account: AccountKey): { key: string; leader: AccountKey } | undefined {
    const row = this.db
      .prepare('SELECT p.key AS key, p.leader AS leader FROM party_member m JOIN party p ON p.key = m.party WHERE m.account = ?')
      .get(account) as { key: string; leader: string } | undefined;
    return row;
  }

  partyMembers(key: string): AccountKey[] {
    return (this.db.prepare('SELECT account FROM party_member WHERE party = ? ORDER BY account').all(key) as
      { account: string }[]).map((r) => r.account);
  }

  partyAddMember(key: string, account: AccountKey, now: number): void {
    this.write('INSERT OR REPLACE INTO party_member (account, party) VALUES (?, ?)').run(account, key);
    this.partyTouch(key, now);
  }

  partyRemoveMember(account: AccountKey): void {
    this.write('DELETE FROM party_member WHERE account = ?').run(account);
  }

  partySetLeader(key: string, leader: AccountKey, now: number): void {
    this.write('UPDATE party SET leader = ?, updated_at = ? WHERE key = ?').run(leader, now, key);
  }

  partyDissolve(key: string): void {
    // party_member rows go via ON DELETE CASCADE.
    this.write('DELETE FROM party WHERE key = ?').run(key);
  }

  partySetting(key: string, name: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM party_setting WHERE party = ? AND name = ?').get(key, name) as
      { value: string } | undefined;
    return row?.value;
  }

  setPartySetting(key: string, name: string, value: string): void {
    this.write('INSERT OR REPLACE INTO party_setting (party, name, value) VALUES (?, ?, ?)').run(key, name, value);
  }

  partyTouch(key: string, now: number): void {
    this.write('UPDATE party SET updated_at = ? WHERE key = ?').run(now, key);
  }

  // Dissolve parties nobody has touched in ages — the guard against a restart resurrecting
  // groups whose members are gone for good. Returns how many were dissolved.
  partySweepStale(cutoff: number): number {
    const stale = (this.db.prepare('SELECT key FROM party WHERE updated_at <= ?').all(cutoff) as { key: string }[]);
    for (const r of stale) this.partyDissolve(r.key);
    return stale.length;
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
