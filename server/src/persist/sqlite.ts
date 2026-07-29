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
  db.exec('PRAGMA journal_mode = WAL');
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
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    // One transaction per migration: a migration that throws leaves NOTHING behind, so the
    // next boot retries it from a clean state instead of resuming a half-applied schema.
    db.exec('BEGIN');
    try {
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
