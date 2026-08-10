// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// TWO PROCESSES OPENING THE SAME SHARED DATABASE AT THE SAME MOMENT.
//
// openDb read the applied-migration set ONCE, before its loop, and used a plain BEGIN — which
// is deferred, so it takes no write lock until the first write. Two processes opening the same
// file together therefore both saw a migration as pending and both ran it, and the second died
// on `CREATE TABLE ... already exists`. openDb throws there, which kills the WORLD PROCESS at
// boot — and the gateway starts its worlds together, so this is a launch-day shape that never
// appears in a test opening one database.
//
// Found by scripts/two-world-soak.ts at twelve concurrent worlds, where it failed roughly one
// run in three. This pins it down deterministically enough to keep.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OPENERS = 16;

test('concurrent openers do not kill each other on the same migration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omw-migrace-'));
  const dbPath = join(dir, 'shared.db');

  // A migration whose up() is NOT idempotent, exactly like the real ones: plain CREATE TABLE,
  // no IF NOT EXISTS. That is the point — the runner has to guarantee it runs once, rather
  // than every migration having to defend itself.
  const child = join(dir, 'open.mjs');
  writeFileSync(child, `
    import { openDb } from ${JSON.stringify(join(process.cwd(), 'src', 'persist', 'sqlite.ts'))};
    // SYNCHRONISED START. Process startup under tsx varies by hundreds of milliseconds, so
    // simply spawning N children never lands them inside the window between "read the applied
    // set" and "COMMIT" — they queue up politely and the race never happens. Every child waits
    // for the same wall-clock instant, then opens.
    const at = Number(process.argv[3]);
    while (Date.now() < at) { /* spin: a timer would reschedule us apart again */ }
    const db = openDb(process.argv[2], [
      { name: '001-thing', up: (d) => d.exec('CREATE TABLE thing (id INTEGER PRIMARY KEY)') },
      { name: '002-other', up: (d) => d.exec('CREATE TABLE other (id INTEGER PRIMARY KEY)') },
    ]);
    db.close();
  `);

  // All of them at once, against a file that does not exist yet: every opener believes it is
  // the one that has to create the schema. spawn, NOT execFileSync — a synchronous spawn runs
  // them one after another, which is precisely the case that never reproduces this.
  // Far enough out that every child is loaded and spinning before it arrives.
  const startAt = Date.now() + 4000;
  const runs = Array.from({ length: OPENERS }, () =>
    new Promise<{ ok: boolean; err: string }>((resolve) => {
      const p = spawn(process.execPath, ['--import', 'tsx', child, dbPath, String(startAt)],
        { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += String(d); });
      p.on('exit', (code) => resolve({ ok: code === 0, err }));
      p.on('error', (e) => resolve({ ok: false, err: String(e) }));
    }));
  const results = await Promise.all(runs);

  const dead = results.filter((r) => !r.ok);
  assert.deepEqual(dead.map((d) => d.err.split('\n').find((l) => l.includes('Error')) ?? 'died'), [],
    `${dead.length}/${OPENERS} openers died; in production each of those is a world process `
    + 'that failed to boot, and the gateway starts its worlds together');
});
