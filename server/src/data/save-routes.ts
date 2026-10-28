// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The savegame STORE: the per-account index of .omwsave files kept in the locker's storage.
//
// v2 has no /saves routes (CL6): a multiplayer character is server-owned state, and the client
// never mirrors saves up. What is left is the index itself, because the dashboard's save
// browser (net/admin/api-saves.ts) and account erasure still read it — "delete my data" must
// also take any saves an older server wrote.

import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { openDb } from '../persist/sqlite';

const SAVE_MIGRATIONS = [
  {
    name: '001-saves',
    up: (db: DatabaseSync) => {
      // One row per save slot. The DIRECTORY is not the source of truth: S3 has no cheap
      // listing, and the two backends have to behave identically or a deployment that
      // switches storage silently loses every save from the list.
      db.exec(`CREATE TABLE player_saves (
        accountKey TEXT NOT NULL,
        name       TEXT NOT NULL,
        size       INTEGER NOT NULL,
        mtime      INTEGER NOT NULL,
        PRIMARY KEY (accountKey, name)
      )`);
    },
  },
  {
    name: '002-saves-scope',
    up: (db: DatabaseSync) => {
      // SAVES MUST NOT CROSS MODES. Multiplayer and the cloud-locker mode share an account and
      // a library on purpose, but they are different games: a multiplayer character is
      // server-owned state, a solo save is a whole world snapshot, and listing one in the
      // other's load screen is at best confusing and at worst a way to overwrite the wrong
      // thing. The name alone was the key, so a "Save 1" in each collided outright.
      //
      // SQLite cannot alter a primary key, so the table is rebuilt. Existing rows are all
      // multiplayer — that is the only mode that existed — so they take scope 'mp', which
      // keeps their storage keys unchanged (see keyOf).
      db.exec(`CREATE TABLE player_saves_v2 (
        accountKey TEXT NOT NULL,
        scope      TEXT NOT NULL,
        name       TEXT NOT NULL,
        size       INTEGER NOT NULL,
        mtime      INTEGER NOT NULL,
        PRIMARY KEY (accountKey, scope, name)
      )`);
      db.exec(`INSERT INTO player_saves_v2 (accountKey, scope, name, size, mtime)
               SELECT accountKey, 'mp', name, size, mtime FROM player_saves`);
      db.exec('DROP TABLE player_saves');
      db.exec('ALTER TABLE player_saves_v2 RENAME TO player_saves');
    },
  },
];

/** Storage key for one save. 'mp' keeps the ORIGINAL layout so every save already in storage
 *  stays exactly where it is — a rename would orphan real players' saves for no benefit.
 *  Other scopes nest under their own folder. Exported so the layout guarantee is testable. */
export function saveKey(account: string, scope: string, name: string): string {
  return scope === 'mp' ? `saves/${account}/${name}` : `saves/${account}/${scope}/${name}`;
}

interface SaveEntry { name: string; size: number; mtime: number }

export class SaveStore {
  private readonly db: DatabaseSync;
  constructor(dataDir: string) {
    this.db = openDb(join(dataDir, 'saves.db'), SAVE_MIGRATIONS);
  }
  list(accountKey: string, scope: string): SaveEntry[] {
    return this.db
      .prepare('SELECT name, size, mtime FROM player_saves WHERE accountKey = ? AND scope = ? ORDER BY name')
      .all(accountKey, scope) as unknown as SaveEntry[];
  }
  /** Quota is per ACCOUNT, across every scope: the budget is storage we are paying for, not
   *  an allowance per game mode. */
  used(accountKey: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(size), 0) AS n FROM player_saves WHERE accountKey = ?')
      .get(accountKey) as { n: number };
    return row.n;
  }
  has(accountKey: string, scope: string, name: string): boolean {
    return this.list(accountKey, scope).some((f) => f.name === name);
  }
  put(accountKey: string, scope: string, e: SaveEntry): void {
    this.db
      .prepare('INSERT OR REPLACE INTO player_saves (accountKey, scope, name, size, mtime) VALUES (?, ?, ?, ?, ?)')
      .run(accountKey, scope, e.name, e.size, e.mtime);
  }
  /** Every save the account has, in every scope. For erasure, which must not miss a mode. */
  listAll(accountKey: string): { scope: string; name: string }[] {
    return this.db.prepare('SELECT scope, name FROM player_saves WHERE accountKey = ?')
      .all(accountKey) as unknown as { scope: string; name: string }[];
  }
  remove(accountKey: string, scope: string, name: string): void {
    this.db.prepare('DELETE FROM player_saves WHERE accountKey = ? AND scope = ? AND name = ?')
      .run(accountKey, scope, name);
  }
}

/** Erasure: a save is personal data like any other. Called by the locker erase path and by
 *  the offline --delete-account tool. */
export async function eraseSaves(
  dataDir: string,
  accountKey: string,
  storage: { delete(prefix: string): Promise<void> } | undefined,
): Promise<number> {
  const store = new SaveStore(dataDir);
  // EVERY scope: "delete my data" that quietly left one game mode behind would be a lie, and
  // the prefix delete below already takes the nested keys with it.
  const all = store.listAll(accountKey);
  await storage?.delete(`saves/${accountKey}/`);
  for (const f of all) store.remove(accountKey, f.scope, f.name);
  return all.length;
}
