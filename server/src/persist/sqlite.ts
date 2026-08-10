// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
//
// Shared SQLite open/migrate helper (docs/SQLITE-CONSOLIDATION.md step 1). Every store that
// moves off JSON goes through here so the pragmas and the migration runner exist in ONE place.
//
// WAL is not optional. The shared dir (accounts, identities, locker, players) is opened by the
// front door AND by every world process at once — verified live: two processes against one
// /data. WAL is exactly the multi-process reader/writer case, and busy_timeout turns a
// concurrent writer from an instant SQLITE_BUSY throw into a short wait.
//
// The pre-existing social.db already runs WAL against that same shared dir, so this is the
// arrangement already proven in production here rather than a new bet.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '../log';

export type Migration = {
  // Human label, logged when applied. Keep it descriptive: it is the schema's changelog.
  name: string;
  up: (db: DatabaseSync) => void;
};

// Open a database, apply pragmas, and run any migrations not yet applied. Idempotent: the
// applied set is recorded in schema_migrations, so re-running is a no-op.
export function openDb(path: string, migrations: Migration[] = []): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // busy_timeout FIRST, before anything that can contend. Switching journal_mode to WAL takes
  // a brief EXCLUSIVE lock, so if another process is mid-write at that moment a connection
  // with no timeout set yet fails outright with "database is locked" — which is precisely what
  // happens when a world process and the front door start together against the shared dir.
  // A two-process concurrent-write test caught this: one process lost every write.
  db.exec('PRAGMA busy_timeout = 5000');
  // WAL: concurrent readers do not block the writer, and a crash mid-write cannot shear the
  // file. Multi-process readers/writers on one file is exactly what WAL is for.
  //
  // Setting it needs a brief EXCLUSIVE lock, and busy_timeout does NOT cover every lock
  // conversion — a concurrent opener can still fail outright. Two things make that safe:
  // the mode is PERSISTENT in the file, so it only has to be set once ever; and a contended
  // attempt is retried rather than thrown. A two-process test caught both the ordering and
  // this: one process died on the pragma and lost every write.
  setWalMode(db);
  // FULL would fsync every commit (slow); NORMAL is the documented WAL pairing and still
  // crash-safe — a power loss can only lose the last commits, never corrupt the file.
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    appliedAt TEXT NOT NULL
  )`);
  const done = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name),
  );
  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?');
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    // One transaction per migration: a migration that throws leaves NOTHING behind, so the
    // next boot retries it from a clean state instead of resuming a half-applied schema.
    //
    // IMMEDIATE, and re-checked INSIDE the transaction. The `done` set above was read once,
    // before the loop, and a plain BEGIN is deferred — it takes no write lock until the first
    // write. So two processes opening the same shared database at the same moment both saw a
    // migration as pending and both ran it, and the second died on `CREATE TABLE ... already
    // exists`. That kills the WORLD PROCESS at boot, and the gateway starts its worlds
    // together, so it is exactly the shape that shows up on a busy launch and never in a test
    // that opens one database. Found by scripts/two-world-soak.ts at eight concurrent worlds.
    //
    // IMMEDIATE takes the write lock up front, which serialises the racing processes;
    // busy_timeout (set above, before anything can contend) makes the loser wait rather than
    // throw. The re-check is what the loser needs when it finally gets the lock.
    db.exec('BEGIN IMMEDIATE');
    try {
      if (applied.get(m.name) !== undefined) {
        db.exec('ROLLBACK'); // another process got there first; nothing to do and nothing wrong
        log('info', 'sqlite.migration_raced', { db: path, migration: m.name });
        continue;
      }
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (name, appliedAt) VALUES (?, ?)')
        .run(m.name, new Date().toISOString());
      db.exec('COMMIT');
      log('info', 'sqlite.migrated', { db: path, migration: m.name });
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration "${m.name}" failed on ${path}: ${String(err)}`);
    }
  }
  return db;
}

// Switch a database to WAL, tolerating a concurrent opener doing the same thing.
function setWalMode(db: DatabaseSync, attempts = 5): void {
  for (let i = 0; i < attempts; i++) {
    const mode = (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
    if (mode.toLowerCase() === 'wal') return; // already persistent in the file
    try {
      db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (err) {
      if (!/lock|busy/i.test(String(err)) || i === attempts - 1) throw err;
      // Spin briefly: the sibling holding the lock is mid-pragma, not mid-transaction.
      const until = Date.now() + 50;
      while (Date.now() < until) { /* short backoff */ }
    }
  }
}

// Run fn inside a transaction, rolling back if it throws. This is the point of the move off
// JSON: multi-row writes that must not be observable half-done.
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
