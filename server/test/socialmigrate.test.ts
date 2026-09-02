// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase W: the party concept is deleted, and live servers carry party rows — so the change is
// a MIGRATION, not a schema edit. A fresh database proves nothing; this builds the OLD schema
// with real rows and asserts what survives, what is rewritten, and what is dropped.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SocialStore } from '../src/core/socialstore';

test('w1-solo-party migrates a POPULATED social.sqlite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omw-socmig-'));
  const path = join(dir, 'social.sqlite');

  // The pre-migration world, written raw: party tables, party-scoped chat, both invite
  // kinds, and a 'party' presence mode.
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE party (key TEXT PRIMARY KEY, leader TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE party_member (account TEXT PRIMARY KEY, party TEXT NOT NULL REFERENCES party(key) ON DELETE CASCADE);
    CREATE TABLE party_setting (party TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (party, name));
    CREATE TABLE chat_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      channel TEXT NOT NULL, scope TEXT NOT NULL, acct TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL);
    CREATE TABLE invite (fromAcct TEXT NOT NULL, toAcct TEXT NOT NULL, kind TEXT NOT NULL,
      sent INTEGER NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY (fromAcct, toAcct));
    CREATE TABLE presence_pref (account TEXT PRIMARY KEY, mode TEXT NOT NULL);
    CREATE TABLE friend (a TEXT NOT NULL, b TEXT NOT NULL, since INTEGER NOT NULL, PRIMARY KEY (a, b), CHECK (a < b));
  `);
  db.prepare("INSERT INTO party VALUES ('pk1', 'alice', 1)").run();
  db.prepare("INSERT INTO party_member VALUES ('alice', 'pk1')").run();
  db.prepare("INSERT INTO party_member VALUES ('bob', 'pk1')").run();
  db.prepare("INSERT INTO party_setting VALUES ('pk1', 'goldSplit', 'true')").run();
  db.prepare("INSERT INTO chat_history (ts, channel, scope, acct, name, text) VALUES (1, 'party', 'pk1', 'alice', 'Alice', 'party line')").run();
  db.prepare("INSERT INTO chat_history (ts, channel, scope, acct, name, text) VALUES (2, 'global', '', 'alice', 'Alice', 'server line')").run();
  db.prepare("INSERT INTO invite VALUES ('alice', 'bob', 'party', 1, 9999999999999)").run();
  db.prepare("INSERT INTO invite VALUES ('carol', 'bob', 'world', 1, 9999999999999)").run();
  db.prepare("INSERT INTO presence_pref VALUES ('alice', 'party')").run();
  db.prepare("INSERT INTO presence_pref VALUES ('bob', 'private')").run();
  db.prepare("INSERT INTO friend VALUES ('alice', 'bob', 1)").run();
  db.close();

  // Opening the store IS the migration.
  const store = new SocialStore(dir);

  // Friendships survive untouched — they are the new door.
  assert.ok(store.areFriends('alice', 'bob'), 'the friendship did not survive');
  // Party-scoped scrollback is gone (nobody can ever read that scope again); '' survives.
  assert.equal(store.recentChat('pk1', 100).length, 0, 'party scrollback outlived the party');
  assert.equal(store.recentChat('', 100).length, 1, 'the server-wide channel was collected too');
  // Party invites are gone; world invites survive.
  const invites = store.invitesFor('bob', 2);
  assert.deepEqual(invites.map((i) => i.from), ['carol'], 'a party invite survived, or a world invite was lost');
  // The 'party' presence mode maps to 'friends'; a stated 'private' is untouched.
  assert.equal(store.getPresenceMode('alice'), 'friends');
  assert.equal(store.getPresenceMode('bob'), 'private');
  store.close();

  // The party tables are dropped, and the migration is RECORDED so it never re-runs.
  const check = new DatabaseSync(path);
  const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .map((r) => r.name);
  for (const t of ['party', 'party_member', 'party_setting']) {
    assert.ok(!tables.includes(t), `${t} was not dropped`);
  }
  assert.ok((check.prepare("SELECT 1 FROM schema_migrations WHERE name = 'w1-solo-party'").get()) !== undefined,
    'the migration was not recorded');
  check.close();

  // Re-opening (a second boot, or a second world process) is a no-op, not a crash.
  const again = new SocialStore(dir);
  assert.ok(again.areFriends('alice', 'bob'));
  again.close();
});
