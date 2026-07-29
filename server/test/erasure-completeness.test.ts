// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Erasure must reach EVERY store. During the JSON->SQLite consolidation this broke four
// separate times — bans, moderation, identities and player docs each kept their rows after an
// "erasure" because erase.ts still knew only the old file layout. Each was a real privacy
// defect. This test fails if a future store is added and erase.ts is not taught about it:
// it sweeps the databases for any surviving trace rather than asserting a hand-written list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AccountStore } from '../src/core/accounts';
import { PlayerStore } from '../src/persist/playerstore';
import { BanStore } from '../src/persist/banstore';
import { IdentityStore } from '../src/auth/identities';
import { ChatLog, ReportStore } from '../src/core/moderation';
import { deleteAccount } from '../src/persist/erase';
import { tmpDataDir } from './helpers';

test('deleting an account leaves no trace in any database', async (t) => {
  void t;
  const dir = tmpDataDir();

  const accounts = new AccountStore(dir);
  await accounts.ready();
  const account = await accounts.register('Victim', 'hunter22');
  assert.ok(typeof account !== 'string', 'fixture account was not created');
  const char = accounts.createCharacter(account, 'Hero');
  assert.ok(typeof char !== 'string', 'fixture character was not created');
  await accounts.setUsername(account, 'VictimHandle');
  await accounts.flush();

  const players = new PlayerStore(dir);
  await players.ready();
  players.update(char.id, (d) => { d.inventory = [{ id: 'gold_001', n: 9 }]; }, 'now');
  await players.flushAll();

  const bans = new BanStore(dir);
  await bans.ready();
  bans.banAccount('Victim', 'admin', 'test');
  await bans.flush();

  const identities = new IdentityStore(dir);
  await identities.ready();
  await identities.bind('https://provider', 'sub-1', 'victim');

  const chat = new ChatLog(dir, { chatLog: true, retentionDays: 14, contextLines: 5 });
  chat.record({
    ts: new Date().toISOString(), playerId: 1, account: 'victim',
    name: 'Victim', channel: 'say', text: 'something private',
  });
  await chat.drain();

  await new ReportStore(dir, 14).write({
    ts: new Date().toISOString(),
    reporter: { id: 1, name: 'Victim', account: 'victim' },
    target: { id: 2, name: 'Other', account: 'other', cellKey: '1,1' },
    reason: 'r',
    context: [],
  });

  const report = await deleteAccount(dir, 'Victim');
  assert.deepEqual(report, {
    account: true, player: true, bans: true, identities: 1, chatLines: 1, reports: 1,
  });

  // Sweep every table in every database for the account key or its character id. Anything
  // that survives is a leak, whichever store it belongs to.
  const needles = ['victim', char.id];
  const leaks: string[] = [];
  for (const file of ['accounts.db', 'players.db', 'bans.db', 'identities.db', 'moderation.db', 'locker.db']) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const db = new DatabaseSync(path);
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
      for (const { name } of tables) {
        if (name === 'schema_migrations') continue;
        const cols = (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((c) => c.name);
        for (const row of db.prepare(`SELECT * FROM ${name}`).all() as Record<string, unknown>[]) {
          const blob = cols.map((c) => String(row[c] ?? '')).join(' ').toLowerCase();
          for (const needle of needles) {
            if (blob.includes(needle.toLowerCase())) leaks.push(`${file}:${name} still names ${needle}`);
          }
        }
      }
    } finally {
      db.close();
    }
  }
  assert.deepEqual(leaks, [], `erasure left data behind:\n${leaks.join('\n')}`);
});
