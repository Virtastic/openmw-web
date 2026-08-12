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
//      attio.db. A crash loses nothing; the next boot drains.
//   3. Feature-flagged: no API key -> completely inert (no queue writes either — an
//      operator who never configured a CRM must not accumulate a hidden mailbox of PII).
//
// PRIVACY: these records carry email addresses. The queue lives in the shared data dir
// next to the account files that already hold the same email; delete-my-data must purge
// both (erase.ts) and the privacy policy must disclose CRM processing (plan 3.55).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../persist/sqlite';
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

const ATTIO_MIGRATIONS = [
  {
    name: '001-attio-queue',
    up: (db: DatabaseSync) => {
      // An outbox of pending CRM upserts, not a store of record. id embeds the enqueue time so
      // ORDER BY id drains oldest-first, the way the timestamped filenames used to sort.
      db.exec(`CREATE TABLE attio_queue (
        id         TEXT PRIMARY KEY,
        accountKey TEXT NOT NULL,
        doc        TEXT NOT NULL
      )`);
    },
  },
];

export class AttioHook {
  private readonly db: DatabaseSync;
  private readonly timer?: NodeJS.Timeout;
  private flushing = false;

  constructor(
    private readonly settings: AttioSettings,
    // Injected for tests; the real one is global fetch.
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.db = openDb(join(settings.dataDir, 'attio.db'), ATTIO_MIGRATIONS);
    if (settings.apiKey !== '' && !this.enabled) {
      // Configured but unusable: worth one loud line, because the operator clearly INTENDED
      // the CRM to work and would otherwise only find out from a log full of retries.
      log('warn', 'attio.disabled_bad_base_url', {
        baseUrl: settings.baseUrl,
        fix: 'set [integrations] attioBaseUrl to an absolute https URL (default https://api.attio.com)',
      });
    }
    if (this.enabled) {
      this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
      this.timer.unref();
    }
  }

  // A KEY IS NOT ENOUGH; the base URL has to be usable too. With baseUrl empty (which a
  // deployment can do by writing attioBaseUrl = "" over the default) every request built a
  // RELATIVE url, fetch threw "Failed to parse URL from /v2/objects/...", and the queue retried
  // it on every drain forever — filling the log with attio.unreachable and never draining a
  // single record. Treated like a missing key: inert, and said once at boot rather than
  // shouted on a timer.
  get enabled(): boolean {
    if (this.settings.apiKey === '') return false;
    try {
      const u = new URL(this.settings.baseUrl);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  // Hot-path side: one local row insert, then an async kick. Never throws.
  enqueue(upsert: AttioUpsert): void {
    if (!this.enabled) return;
    try {
      // id sorts by time, so the queue drains oldest-first exactly as the filename sort did.
      this.db
        .prepare('INSERT INTO attio_queue (id, accountKey, doc) VALUES (?, ?, ?)')
        .run(`${Date.now()}-${randomBytes(4).toString('hex')}`, upsert.accountKey ?? '', JSON.stringify(upsert));
    } catch (err) {
      log('error', 'attio.enqueue_failed', { error: String(err) });
      return;
    }
    void this.flush();
  }

  // Drains up to MAX_BATCH_PER_FLUSH queued upserts. A failed item stays queued for the
  // next interval; one failure does not block the rest (each is independent).
  async flush(): Promise<void> {
    if (!this.enabled || this.flushing) return;
    this.flushing = true;
    try {
      const rows = this.db
        .prepare('SELECT id, doc FROM attio_queue ORDER BY id LIMIT ?')
        .all(MAX_BATCH_PER_FLUSH) as { id: string; doc: string }[];
      const drop = this.db.prepare('DELETE FROM attio_queue WHERE id = ?');
      for (const row of rows) {
        let upsert: AttioUpsert;
        try {
          upsert = JSON.parse(row.doc) as AttioUpsert;
        } catch {
          drop.run(row.id); // unreadable: drop rather than wedge the queue
          continue;
        }
        if (await this.send(upsert)) drop.run(row.id);
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
    // accountKey is a column, so this is the whole job — no scan-and-parse of every entry.
    try {
      this.db.prepare('DELETE FROM attio_queue WHERE accountKey = ?').run(accountKey);
    } catch (err) {
      log('error', 'attio.purge_failed', { error: String(err) });
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}
