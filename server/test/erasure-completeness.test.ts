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
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AccountStore } from '../src/core/accounts';
import { PlayerStore } from '../src/persist/playerstore';
import { BanStore } from '../src/persist/banstore';
import { IdentityStore } from '../src/auth/identities';
import { ChatLog, ReportStore } from '../src/core/moderation';
import { deleteAccount } from '../src/persist/erase';
import { Locker } from '../src/data/locker';
import { SaveStore } from '../src/data/save-routes';
import { SocialStore } from '../src/core/socialstore';
import { tmpDataDir } from './helpers';

test('deleting an account leaves no trace in any database', async (t) => {
  void t;
  const dir = tmpDataDir();

  const accounts = new AccountStore(dir);
  const account = await accounts.register('Victim', 'hunter22');
  assert.ok(typeof account !== 'string', 'fixture account was not created');
  const char = accounts.createCharacter(account, 'Hero');
  assert.ok(typeof char !== 'string', 'fixture character was not created');
  await accounts.setUsername(account, 'VictimHandle');
  await accounts.flush();

  const players = new PlayerStore(dir);
  players.update(char.id, (d) => { d.inventory = [{ id: 'gold_001', n: 9 }]; }, 'now');
  await players.flushAll();

  const bans = new BanStore(dir);
  bans.banAccount('Victim', 'admin', 'test');
  await bans.flush();

  const identities = new IdentityStore(dir);
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

  // The locker attestation names the person and is written by the server, so it must go too.
  // Left in place deliberately: the OFFLINE eraser has to reach it. It did not, for as long
  // as the locker existed — an erased account's library and attestation both survived.
  const locker = new Locker({ dataDir: dir, maxBytesPerAccount: 1 });
  await locker.attest('victim', [{ name: 'Morrowind.esm', size: 1, sha256: 'a'.repeat(64) }], '1.2.3.4');
  assert.ok(await locker.attestationOf('victim'), 'fixture attestation was not written');

  // Both scopes: erasure that leaves one game mode's saves behind is not erasure.
  new SaveStore(dir).put('victim', 'mp', { name: 'Hero - Save 1.omwsave', size: 4, mtime: 1 });
  new SaveStore(dir).put('victim', 'solo', { name: 'Hero - Save 1.omwsave', size: 4, mtime: 1 });

  // THE SOCIAL GRAPH IS PERSONAL DATA. Friends, blocks, mutes, the requests and invites you
  // sent, your presence row (display name, last cell) and your own chat lines all name you.
  const social = new SocialStore(dir);
  const nowMs = Date.now();
  social.addFriend('victim', 'other', nowMs);
  social.addBlock('victim', 'someone', nowMs);
  social.setPresence('victim', 'w', 'Victim', '1,1', false, nowMs);
  social.appendChat(
    { ts: nowMs, channel: 'say', scope: 'w', acct: 'victim', name: 'Victim', text: 'private' }, 50);
  social.close();

  const report = await deleteAccount(dir, 'Victim');
  assert.deepEqual(report, {
    account: true, player: true, bans: true, identities: 1,
    // BOTH copies of the person's chat: the moderation log and the social history.
    chatLines: 2, reports: 1,
    locker: true, saves: 2,   // one per scope: erasure must not leave a mode behind
    socialRows: 3,            // friend + block + presence (the chat line is counted above)
  });

  // Sweep every table in every database for the account key or its character id. Anything
  // that survives is a leak, whichever store it belongs to.
  const needles = ['victim', char.id];
  const leaks: string[] = [];
  // EVERY database in the directory, discovered rather than listed. The hand-maintained list
  // this replaced omitted social.sqlite, so an erasure that left behind friends, blocks,
  // presence and the person's own chat lines passed this "completeness" test for as long as
  // the social layer existed. A store added tomorrow is swept without anyone remembering to.
  for (const file of readdirSync(dir).filter((f) => /\.(db|sqlite)$/.test(f))) {
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
