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

import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, tx } from './sqlite';
import { log } from '../log';
import { timeFlush } from '../metrics';

export interface BanEntry {
  by: string; // admin account name
  at: string; // ISO timestamp
  reason: string;
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
];

export class BanStore {
  private readonly db: DatabaseSync;
  private doc: BansDoc = { accounts: {}, ips: {} };
  private write: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.db = openDb(join(dataDir, 'bans.db'), MIGRATIONS);
    this.load();
  }

  private load(): void {
    const rows = this.db.prepare('SELECT scope, key, by, at, reason FROM bans').all() as
      { scope: string; key: string; by: string; at: string; reason: string }[];
    for (const r of rows) {
      const target = r.scope === 'ip' ? this.doc.ips : this.doc.accounts;
      target[r.key] = { by: r.by, at: r.at, reason: r.reason };
    }
  }

  isAccountBanned(name: string): BanEntry | undefined {
    return this.doc.accounts[name.toLowerCase()];
  }

  isIpBanned(ip: string): BanEntry | undefined {
    return this.doc.ips[ip];
  }

  banAccount(name: string, by: string, reason: string): void {
    const key = name.toLowerCase();
    const entry = { by, at: new Date().toISOString(), reason };
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

  banIp(ip: string, by: string, reason: string): void {
    const entry = { by, at: new Date().toISOString(), reason };
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
    return Object.keys(this.doc.accounts);
  }

  listIps(): string[] {
    return Object.keys(this.doc.ips);
  }

  private put(scope: 'account' | 'ip', key: string, e: BanEntry): void {
    this.run(() =>
      this.db
        .prepare('INSERT OR REPLACE INTO bans (scope, key, by, at, reason) VALUES (?, ?, ?, ?, ?)')
        .run(scope, key, e.by, e.at, e.reason),
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

  flush(): Promise<void> {
    return this.write;
  }
}
