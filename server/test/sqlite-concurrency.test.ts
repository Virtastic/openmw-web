// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The shared dir (accounts, identities, locker, players) is opened by the front door AND by
// every world process at once, so the persistence layer's multi-process behaviour is a real
// requirement, not a theoretical one. These tests pin the two things that make it work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/persist/sqlite';

const here = fileURLToPath(new URL('.', import.meta.url));

test('pragmas are ordered so a concurrent opener cannot fail outright', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omw-sqlite-'));
  const db = openDb(join(dir, 'x.db'));
  // busy_timeout must be in place BEFORE journal_mode=WAL, which takes a brief EXCLUSIVE
  // lock: a connection that reaches that statement with no timeout set dies with "database
  // is locked" the moment another process is mid-write. Setting WAL first cost one of two
  // concurrent writers EVERY write in a real two-process test.
  assert.equal((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 5000);
  assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
  db.close();
});

test('two processes writing the same shared DB both land every row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omw-sqlite-'));
  const child = join(here, 'fixtures', 'concurrent-writer.mjs');
  const run = (tag: string) =>
    new Promise<number>((resolve, reject) => {
      const p = fork(child, [dir, tag, '25'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let out = '';
      p.stdout?.on('data', (d) => (out += String(d)));
      p.stderr?.on('data', (d) => (out += String(d)));
      p.on('exit', (code) =>
        code === 0 ? resolve(Number(/wrote=(\d+)/.exec(out)?.[1] ?? -1)) : reject(new Error(out)),
      );
    });
  const [a, b] = await Promise.all([run('alpha'), run('bravo')]);
  assert.equal(a, 25, 'first process lost writes');
  assert.equal(b, 25, 'second process lost writes');
  const db = openDb(join(dir, 'concurrent.db'));
  const n = (db.prepare('SELECT COUNT(*) AS n FROM kv').get() as { n: number }).n;
  db.close();
  assert.equal(n, 50, 'rows from both processes must survive');
});
