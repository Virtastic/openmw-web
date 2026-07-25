// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Account store: one JSON file per account at <dataDir>/accounts/<nameLower>.json,
// argon2id (OWASP 2024 baseline: m=19456 KiB, t=2, p=1). Mutations write through the
// dirty queue; flush() drains it (SIGUSR1 / shutdown / 30 s timer).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import { readJson, writeJsonAtomic } from '../persist/atomicjson';
import { log } from '../log';

export interface Account {
  name: string; // display casing as registered
  pwHash: string;
  createdAt: string;
  lastSeenAt: string;
  rank: number; // 0 = player, >=1 = admin (seeded by editing the JSON by hand in M0)
  banned?: boolean;
}

const ARGON2_OPTS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const NAME_RE = /^[A-Za-z0-9_ -]{2,24}$/;

export function validAccountName(name: string): boolean {
  return NAME_RE.test(name);
}

export class AccountStore {
  private readonly dir: string;
  private cache = new Map<string, Account>(); // key = nameLower
  private dirty = new Set<string>();
  private flushTimer: NodeJS.Timeout;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'accounts');
    mkdirSync(this.dir, { recursive: true });
    this.flushTimer = setInterval(() => void this.flush(), 30_000);
    this.flushTimer.unref();
  }

  private path(nameLower: string): string {
    return join(this.dir, `${nameLower}.json`);
  }

  async get(name: string): Promise<Account | undefined> {
    const key = name.toLowerCase();
    const cached = this.cache.get(key);
    if (cached) return cached;
    const loaded = await readJson<Account>(this.path(key));
    if (loaded) this.cache.set(key, loaded);
    return loaded;
  }

  // 'exists' | 'badname' | the new account. Uniqueness is case-insensitive (file name).
  async register(name: string, password: string): Promise<Account | 'exists' | 'badname'> {
    if (!validAccountName(name)) return 'badname';
    if (await this.get(name)) return 'exists';
    const now = new Date().toISOString();
    const account: Account = {
      name,
      pwHash: await hash(password, ARGON2_OPTS),
      createdAt: now,
      lastSeenAt: now,
      rank: 0,
    };
    const key = name.toLowerCase();
    this.cache.set(key, account);
    await writeJsonAtomic(this.path(key), account);
    return account;
  }

  // null on unknown account or wrong password (indistinguishable to the caller by design).
  async verifyLogin(name: string, password: string): Promise<Account | null> {
    const account = await this.get(name);
    if (!account) return null;
    return (await verify(account.pwHash, password)) ? account : null;
  }

  // M8: rank/ban mutations go through the dirty queue like lastSeen. The account must be
  // in cache (every caller has just awaited get()).
  setRank(name: string, rank: number): void {
    const account = this.cache.get(name.toLowerCase());
    if (!account) return;
    account.rank = rank;
    this.dirty.add(name.toLowerCase());
  }

  setBanned(name: string, banned: boolean): void {
    const account = this.cache.get(name.toLowerCase());
    if (!account) return;
    if (banned) account.banned = true;
    else delete account.banned;
    this.dirty.add(name.toLowerCase());
  }

  // Erasure (--delete-account): forget the cached copy so nothing rewrites the file we
  // are about to unlink.
  forget(name: string): void {
    const key = name.toLowerCase();
    this.cache.delete(key);
    this.dirty.delete(key);
  }

  touchLastSeen(name: string): void {
    const key = name.toLowerCase();
    const account = this.cache.get(key);
    if (!account) return;
    account.lastSeenAt = new Date().toISOString();
    this.dirty.add(key);
  }

  async flush(): Promise<void> {
    const keys = [...this.dirty];
    this.dirty.clear();
    for (const key of keys) {
      const account = this.cache.get(key);
      if (!account) continue;
      try {
        await writeJsonAtomic(this.path(key), account);
      } catch (err) {
        this.dirty.add(key); // retry on the next flush
        log('error', 'accounts.flush_failed', { account: key, error: String(err) });
      }
    }
  }

  async close(): Promise<void> {
    clearInterval(this.flushTimer);
    await this.flush();
  }
}
