// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Server-side savegames: real .omwsave files, per account.
//
//   GET  /saves                    list this account's saves
//   POST /saves/authorize-upload   -> a presigned PUT for one save
//   POST /saves/uploaded           confirm it landed (records name/size/mtime)
//   GET  /saves/download?name=     -> a presigned GET (owner only)
//   POST /saves/delete             remove one save
//
// WHY THIS EXISTS. Saves lived in the browser's IndexedDB and nowhere else, and
// navigator.storage.persist() is a request, not a promise — an eviction under storage
// pressure took the whole character with it, and there was no way to play the same save on
// a second machine. The one durable mode was ?src=local, where saves mirror to a folder on
// the player's own disk. This is that same mirror with the server standing in for the
// folder, for the two modes that have no folder: server-hosted game data, and the locker.
//
// It reuses the locker's STORAGE (S3 or the filesystem fallback) under a different key
// prefix, and the locker's AUTH posture exactly: the account comes from the Bearer token,
// never from the request, and a name that is not in this account's list is a 404 rather
// than a 403 — the answer must not tell you whether somebody else's save exists.
//
// These are .omwsave FILES, not the server's PlayerDoc. PlayerDoc is a re-entry ticket for
// a live multiplayer world (position, gear, stats) and carries no world state, script state
// or load order; it cannot be turned into a savegame and is not involved here.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { openDb } from '../persist/sqlite';
import type { HttpRoute } from '../net/http';
import type { LockerSessions } from './locker-routes';
import { log } from '../log';

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

/** Which game a save belongs to. Anything unrecognised is treated as multiplayer, which is
 *  what every save written before this existed actually was. */
const SCOPES = new Set(['mp', 'solo']);
function scopeOf(v: unknown): 'mp' | 'solo' {
  return v === 'solo' ? 'solo' : 'mp';
}

// A save name is a filename and nothing else. An allow-list, not a deny-list: with the
// filesystem backend this becomes a real path, and the interesting attacks are the ones
// nobody thought to deny. OpenMW's own slot names are the character name plus a label.
const SAVE_NAME = /^[A-Za-z0-9 ._'()\-]{1,128}\.omwsave$/;

/** Storage key for one save. 'mp' keeps the ORIGINAL layout so every save already in storage
 *  stays exactly where it is — a rename would orphan real players' saves for no benefit.
 *  Other scopes nest under their own folder. Exported so the layout guarantee is testable. */
export function saveKey(account: string, scope: string, name: string): string {
  return scope === 'mp' ? `saves/${account}/${name}` : `saves/${account}/${scope}/${name}`;
}

export interface SaveRouteDeps {
  storage: {
    presignPut(key: string, contentLength: number): Promise<string>;
    presignGet(key: string): Promise<string>;
    delete(prefix: string): Promise<void>;
  } | undefined;
  sessions: LockerSessions;
  dataDir: string;
  maxBytesPerAccount: number;
}

export interface SaveEntry { name: string; size: number; mtime: number }

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

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

async function readBody(req: IncomingMessage, limit = 65536): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('too large');
  }
  return JSON.parse(body || '{}') as Record<string, unknown>;
}

function saveName(v: unknown): string | undefined {
  return typeof v === 'string' && SAVE_NAME.test(v) ? v : undefined;
}

export function saveRoutes(deps: SaveRouteDeps): HttpRoute {
  const store = new SaveStore(deps.dataDir);
  // Per-account prefix, same rule as the locker: never a shared or content-addressed key.
  const keyOf = saveKey;

  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== '/saves' && !url.pathname.startsWith('/saves/')) return false;
    res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    if (!deps.storage) { json(res, 503, { error: 'saves_disabled' }); return true; }

    const auth = req.headers.authorization ?? '';
    const accountKey = deps.sessions.resolve(auth.startsWith('Bearer ') ? auth.slice(7) : '');
    if (!accountKey) { json(res, 401, { error: 'sign_in_first' }); return true; }

    try {
      // Scope rides every request: the client knows which game it is, and the server keeps
      // the two apart. An absent or unknown value means multiplayer, which is what every save
      // written before scopes existed actually is.
      if (req.method === 'GET' && url.pathname === '/saves') {
        const scope = scopeOf(url.searchParams.get('scope'));
        json(res, 200, { files: store.list(accountKey, scope), quota: deps.maxBytesPerAccount });
        return true;
      }

      if (req.method === 'POST' && url.pathname === '/saves/authorize-upload') {
        const body = await readBody(req);
        const name = saveName(body.name);
        const size = typeof body.size === 'number' && Number.isFinite(body.size) && body.size >= 0
          ? Math.floor(body.size) : undefined;
        if (!name || size === undefined) { json(res, 400, { error: 'bad_save' }); return true; }
        const scope = scopeOf(body.scope);
        // Replacing a slot frees its old bytes, so charge only the difference.
        const prior = store.list(accountKey, scope).find((f) => f.name === name)?.size ?? 0;
        if (store.used(accountKey) - prior + size > deps.maxBytesPerAccount) {
          json(res, 200, { ok: false, reason: 'quota' });
          return true;
        }
        json(res, 200, { ok: true, url: await deps.storage.presignPut(keyOf(accountKey, scope, name), size) });
        return true;
      }

      if (req.method === 'POST' && url.pathname === '/saves/uploaded') {
        const body = await readBody(req);
        const name = saveName(body.name);
        const size = typeof body.size === 'number' ? Math.floor(body.size) : undefined;
        if (!name || size === undefined) { json(res, 400, { error: 'bad_save' }); return true; }
        const mtime = typeof body.mtime === 'number' && Number.isFinite(body.mtime)
          ? Math.floor(body.mtime) : Date.now();
        store.put(accountKey, scopeOf(body.scope), { name, size, mtime });
        return json(res, 200, { ok: true }), true;
      }

      if (req.method === 'GET' && url.pathname === '/saves/download') {
        const name = saveName(url.searchParams.get('name'));
        const scope = scopeOf(url.searchParams.get('scope'));
        // Not in YOUR list is 404 whether or not it exists for somebody else — and a save in
        // the OTHER mode is not in this list, so the modes cannot reach each other's slots.
        if (!name || !store.has(accountKey, scope, name)) { json(res, 404, { error: 'not_yours' }); return true; }
        json(res, 200, { url: await deps.storage.presignGet(keyOf(accountKey, scope, name)) });
        return true;
      }

      if (req.method === 'POST' && url.pathname === '/saves/delete') {
        const delBody = await readBody(req);
        const name = saveName(delBody.name);
        const scope = scopeOf(delBody.scope);
        if (!name || !store.has(accountKey, scope, name)) { json(res, 404, { error: 'not_yours' }); return true; }
        await deps.storage.delete(keyOf(accountKey, scope, name));
        store.remove(accountKey, scope, name);
        json(res, 200, { ok: true });
        return true;
      }

      json(res, 404, { error: 'not_found' });
      return true;
    } catch (err) {
      log('error', 'saves.route_threw', { path: url.pathname, error: String(err) });
      json(res, 500, { error: 'internal' });
      return true;
    }
  };
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
