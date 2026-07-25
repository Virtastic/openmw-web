// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M8 ban list: <dataDir>/bans.json, atomic writes, loaded before the listener opens.
// Two independent lists — accounts (by lowercased name) and IPs — because an account ban
// is about a person and an IP ban is about a source. IP bans are checked at socket accept
// (cheapest possible refusal); account bans at auth and at resume.
//
// PRIVACY.md: an IP ban is the ONLY place this server persists an IP address. Lifting the
// ban erases it.

import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './atomicjson';
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

export class BanStore {
  private readonly path: string;
  private doc: BansDoc = { accounts: {}, ips: {} };
  private loaded: Promise<void>;
  private write: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.path = join(dataDir, 'bans.json');
    this.loaded = readJson<BansDoc>(this.path).then((d) => {
      if (d) this.doc = { accounts: d.accounts ?? {}, ips: d.ips ?? {} };
    });
  }

  ready(): Promise<void> {
    return this.loaded;
  }

  isAccountBanned(name: string): BanEntry | undefined {
    return this.doc.accounts[name.toLowerCase()];
  }

  isIpBanned(ip: string): BanEntry | undefined {
    return this.doc.ips[ip];
  }

  banAccount(name: string, by: string, reason: string): void {
    this.doc.accounts[name.toLowerCase()] = { by, at: new Date().toISOString(), reason };
    this.save();
  }

  // Returns false when nothing was lifted, so the caller can say so plainly.
  unbanAccount(name: string): boolean {
    const key = name.toLowerCase();
    if (!this.doc.accounts[key]) return false;
    delete this.doc.accounts[key];
    this.save();
    return true;
  }

  banIp(ip: string, by: string, reason: string): void {
    this.doc.ips[ip] = { by, at: new Date().toISOString(), reason };
    this.save();
  }

  unbanIp(ip: string): boolean {
    if (!this.doc.ips[ip]) return false;
    delete this.doc.ips[ip];
    this.save();
    return true;
  }

  listAccounts(): string[] {
    return Object.keys(this.doc.accounts);
  }

  listIps(): string[] {
    return Object.keys(this.doc.ips);
  }

  private save(): void {
    this.write = this.write.then(() =>
      timeFlush('bans', () => writeJsonAtomic(this.path, this.doc)).catch((err) =>
        log('error', 'bans.flush_failed', { error: String(err) }),
      ),
    );
  }

  flush(): Promise<void> {
    return this.write;
  }
}
