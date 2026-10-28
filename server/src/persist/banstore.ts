// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M8 ban list: <dataDir>/bans.db (SQLite). Two independent tables — accounts (by lowercased
// name) and IPs — because an account ban is about a person and an IP ban is about a source.
// IP bans are checked at socket accept (cheapest possible refusal); account bans at auth and
// at resume.
//
// PRIVACY.md: an IP ban is the ONLY place this server persists an IP address. Lifting the
// ban erases it — a DELETE here, so the value is gone from the table rather than lingering in
// a rewritten JSON blob.
//
// Reads stay in memory because isIpBanned runs on every accept; SQLite is the durable side,
// not the read path.
//
// OT3-187: a ban may carry `until` (ISO). An expired ban lifts itself on the next read, in
// whichever process reads it first, and logs ban.expired; no timer needed.

import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { checkpoint, openDb, tx } from './sqlite';
import { log } from '../log';
import { timeFlush } from '../metrics';

export interface BanEntry {
  by: string; // admin account name
  at: string; // ISO timestamp
  reason: string;
  until?: string; // ISO; absent = permanent
}

interface BansDoc {
  accounts: Record<string, BanEntry>; // key = account nameLower
  ips: Record<string, BanEntry>;
}

const MIGRATIONS = [
  {
    name: '001-bans',
    up: (db: DatabaseSync) => {
      db.exec(`CREATE TABLE bans (
        scope  TEXT NOT NULL,           -- 'account' | 'ip'
        key    TEXT NOT NULL,           -- account nameLower, or the IP
        by     TEXT NOT NULL,
        at     TEXT NOT NULL,
        reason TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      )`);
    },
  },
  { name: '002-ban-until', up: (db: DatabaseSync) => db.exec('ALTER TABLE bans ADD COLUMN until TEXT') },
];

const live = (e: BanEntry | undefined, now = Date.now()): boolean =>
  !!e && (e.until === undefined || Date.parse(e.until) > now);

export class BanStore {
  private readonly db: DatabaseSync;
  private doc: BansDoc = { accounts: {}, ips: {} };
  private write: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.db = openDb(join(dataDir, 'bans.db'), MIGRATIONS);
    this.load();
  }

  private load(): void {
    const rows = this.db.prepare('SELECT scope, key, by, at, reason, until FROM bans').all() as
      { scope: string; key: string; by: string; at: string; reason: string; until: string | null }[];
    for (const r of rows) {
      const target = r.scope === 'ip' ? this.doc.ips : this.doc.accounts;
      target[r.key] = { by: r.by, at: r.at, reason: r.reason, ...(r.until ? { until: r.until } : {}) };
    }
  }

  // READ THROUGH TO THE DB, not the boot-time snapshot. bans.db is SHARED by every world
  // process the gateway spawns plus the front door, so an in-memory map is only ever correct
  // for bans that existed when THIS process started: ban someone from world A and they walk
  // straight back into world B, or their own already-running solo world, because B's copy
  // predates the ban. (The map was written when a deployment was one process.) A prepared
  // statement against a WAL database is cheap enough for the accept path, and `load()` stays
  // as the warm cache for the list/report views.
  // Prepared lazily: a property initializer would run before the constructor assigns `db`.
  private lookupStmt: ReturnType<DatabaseSync['prepare']> | undefined;

  private read(scope: 'account' | 'ip', key: string): BanEntry | undefined {
    const target = scope === 'ip' ? this.doc.ips : this.doc.accounts;
    let entry: BanEntry | undefined;
    try {
      this.lookupStmt ??= this.db.prepare(
        'SELECT by, at, reason, until FROM bans WHERE scope = ? AND key = ?');
      const row = this.lookupStmt.get(scope, key) as
        { by: string; at: string; reason: string; until: string | null } | undefined;
      entry = row && { by: row.by, at: row.at, reason: row.reason, ...(row.until ? { until: row.until } : {}) };
    } catch {
      // A read failure must not open the door: fall back to the snapshot.
      entry = target[key];
    }
    if (!entry || live(entry)) return entry;
    delete target[key];
    this.remove(scope, key);
    log('info', 'ban.expired', { scope, key: scope === 'ip' ? '(ip)' : key, by: entry.by, until: entry.until });
    return undefined;
  }

  isAccountBanned(name: string): BanEntry | undefined {
    return this.read('account', name.toLowerCase());
  }

  isIpBanned(ip: string): BanEntry | undefined {
    return this.read('ip', ip);
  }

  banAccount(name: string, by: string, reason: string, until?: number): void {
    const key = name.toLowerCase();
    const entry = { by, at: new Date().toISOString(), reason, ...(until ? { until: new Date(until).toISOString() } : {}) };
    this.doc.accounts[key] = entry;
    this.put('account', key, entry);
  }

  // Returns false when nothing was lifted, so the caller can say so plainly.
  unbanAccount(name: string): boolean {
    const key = name.toLowerCase();
    if (!this.doc.accounts[key]) return false;
    delete this.doc.accounts[key];
    this.remove('account', key);
    return true;
  }

  banIp(ip: string, by: string, reason: string, until?: number): void {
    const entry = { by, at: new Date().toISOString(), reason, ...(until ? { until: new Date(until).toISOString() } : {}) };
    this.doc.ips[ip] = entry;
    this.put('ip', ip, entry);
  }

  unbanIp(ip: string): boolean {
    if (!this.doc.ips[ip]) return false;
    delete this.doc.ips[ip];
    this.remove('ip', ip);
    return true;
  }

  listAccounts(): string[] {
    return Object.keys(this.doc.accounts).filter((k) => live(this.doc.accounts[k]));
  }

  listIps(): string[] {
    return Object.keys(this.doc.ips).filter((k) => live(this.doc.ips[k]));
  }

  private put(scope: 'account' | 'ip', key: string, e: BanEntry): void {
    this.run(() =>
      this.db
        .prepare('INSERT OR REPLACE INTO bans (scope, key, by, at, reason, until) VALUES (?, ?, ?, ?, ?, ?)')
        .run(scope, key, e.by, e.at, e.reason, e.until ?? null),
    );
  }

  private remove(scope: 'account' | 'ip', key: string): void {
    this.run(() => this.db.prepare('DELETE FROM bans WHERE scope = ? AND key = ?').run(scope, key));
  }

  // Writes are synchronous in node:sqlite; the promise chain is kept so flush() still means
  // "every write this store issued has landed" for callers and tests that await it.
  private run(fn: () => void): void {
    this.write = this.write.then(() =>
      timeFlush('bans', async () => fn()).catch((err) =>
        log('error', 'bans.flush_failed', { error: String(err) }),
      ),
    );
  }

  async flush(): Promise<void> {
    await this.write;
    checkpoint(this.db);
  }

  async close(): Promise<void> {
    await this.flush();
    this.db.close();
  }
}
