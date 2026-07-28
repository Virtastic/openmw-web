// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Attio CRM capture hook. On profile completion (and email change) the relay upserts a
// person record — email, username, signup date, auth provider, marketing consent — into
// the operator's Attio workspace.
//
// Design constraints, in order:
//   1. Signup must NEVER fail or slow because the CRM is down: enqueue is a local file
//      write; the network call happens off the hot path with retries.
//   2. The queue is DURABLE: one JSON file per pending upsert under
//      <sharedDir>/integrations/attio-queue/. A crash loses nothing; the next boot drains.
//   3. Feature-flagged: no API key -> completely inert (no queue writes either — an
//      operator who never configured a CRM must not accumulate a hidden mailbox of PII).
//
// PRIVACY: these records carry email addresses. The queue lives in the shared data dir
// next to the account files that already hold the same email; delete-my-data must purge
// both (erase.ts) and the privacy policy must disclose CRM processing (plan 3.55).

import { mkdirSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeJsonAtomic } from '../persist/atomicjson';
import { log } from '../log';

export interface AttioUpsert {
  email: string;
  username?: string;
  accountKey: string;
  signupAt: string; // ISO
  provider: string; // 'password' | 'discord' | 'google' | ... (auth rung, not a secret)
  marketingOptIn: boolean;
}

export interface AttioSettings {
  apiKey: string; // '' = disabled
  baseUrl: string; // default https://api.attio.com; overridable for tests/proxies
  dataDir: string; // the SHARED dir; the queue lives under it
}

const FLUSH_INTERVAL_MS = 60_000;
const MAX_BATCH_PER_FLUSH = 20; // a boot after long downtime must not burst-hammer the API

export class AttioHook {
  private readonly queueDir: string;
  private readonly timer?: NodeJS.Timeout;
  private flushing = false;

  constructor(
    private readonly settings: AttioSettings,
    // Injected for tests; the real one is global fetch.
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.queueDir = join(settings.dataDir, 'integrations', 'attio-queue');
    if (this.enabled) {
      mkdirSync(this.queueDir, { recursive: true });
      this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
      this.timer.unref();
    }
  }

  get enabled(): boolean {
    return this.settings.apiKey !== '';
  }

  // Hot-path side: a single local file write, then an async kick. Never throws.
  enqueue(upsert: AttioUpsert): void {
    if (!this.enabled) return;
    const name = `${Date.now()}-${randomBytes(4).toString('hex')}.json`;
    writeJsonAtomic(join(this.queueDir, name), upsert)
      .then(() => void this.flush())
      .catch((err) => log('error', 'attio.enqueue_failed', { error: String(err) }));
  }

  // Drains up to MAX_BATCH_PER_FLUSH queued upserts. A failed item stays queued for the
  // next interval; one failure does not block the rest (each is independent).
  async flush(): Promise<void> {
    if (!this.enabled || this.flushing) return;
    this.flushing = true;
    try {
      let names: string[];
      try {
        names = (await readdir(this.queueDir)).filter((n) => n.endsWith('.json')).sort();
      } catch {
        return; // queue dir gone (never enabled / erased) — nothing to do
      }
      for (const name of names.slice(0, MAX_BATCH_PER_FLUSH)) {
        const path = join(this.queueDir, name);
        let upsert: AttioUpsert;
        try {
          upsert = JSON.parse(await readFile(path, 'utf8')) as AttioUpsert;
        } catch {
          await rm(path, { force: true }); // unreadable: drop rather than wedge the queue
          continue;
        }
        if (await this.send(upsert)) await rm(path, { force: true });
      }
    } finally {
      this.flushing = false;
    }
  }

  // Attio "assert person" keyed on the email: create-or-update in one call, so retries
  // and email changes are both just another assert. Only standard attributes are sent —
  // custom workspace attributes would 400 on workspaces that lack them.
  private async send(upsert: AttioUpsert): Promise<boolean> {
    try {
      const res = await this.fetchFn(
        `${this.settings.baseUrl}/v2/objects/people/records?matching_attribute=email_addresses`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${this.settings.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            data: {
              values: {
                email_addresses: [{ email_address: upsert.email }],
                ...(upsert.username !== undefined
                  ? { name: [{ first_name: upsert.username, last_name: '', full_name: upsert.username }] }
                  : {}),
              },
            },
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) {
        // 4xx (bad key, bad shape) will not heal by retrying forever, but silently
        // dropping a consented signup is worse — keep it queued and keep the operator
        // informed. 5xx/network is the normal retry case.
        log('warn', 'attio.upsert_failed', { status: res.status, account: upsert.accountKey });
        return false;
      }
      log('info', 'attio.upserted', { account: upsert.accountKey });
      return true;
    } catch (err) {
      log('warn', 'attio.unreachable', { error: String(err) });
      return false;
    }
  }

  // delete-my-data: drop any queued upsert for this account. (Records already in Attio
  // are the operator's to purge per their runbook; we stop what has not left the box.)
  async purgeAccount(accountKey: string): Promise<void> {
    if (!this.enabled) return;
    let names: string[];
    try {
      names = (await readdir(this.queueDir)).filter((n) => n.endsWith('.json'));
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(this.queueDir, name);
      try {
        const upsert = JSON.parse(await readFile(path, 'utf8')) as AttioUpsert;
        if (upsert.accountKey === accountKey) await rm(path, { force: true });
      } catch {
        // unreadable entries are dropped by flush(); leave them to it
      }
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}
