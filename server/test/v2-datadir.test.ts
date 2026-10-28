// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// CL16 (OT3-230): v2 starts on a fresh data dir. A v1 accounts.db (001 applied, no v2 marker)
// is refused at open; a fresh one is marked and reopens fine.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AccountStore } from '../src/core/accounts';

test('a fresh data dir opens, and reopens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omw-v2dd-'));
  new AccountStore(dir);
  assert.doesNotThrow(() => new AccountStore(dir));
});

test('a v1 accounts.db is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omw-v2dd-'));
  const db = new DatabaseSync(join(dir, 'accounts.db'));
  db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, appliedAt TEXT NOT NULL)');
  db.exec("INSERT INTO schema_migrations VALUES ('001-accounts', '2026-01-01')");
  db.close();
  assert.throws(() => new AccountStore(dir), /v1 data dir/);
});
