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
];

// A save name is a filename and nothing else. An allow-list, not a deny-list: with the
// filesystem backend this becomes a real path, and the interesting attacks are the ones
// nobody thought to deny. OpenMW's own slot names are the character name plus a label.
const SAVE_NAME = /^[A-Za-z0-9 ._'()\-]{1,128}\.omwsave$/;

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
  list(accountKey: string): SaveEntry[] {
    return this.db
      .prepare('SELECT name, size, mtime FROM player_saves WHERE accountKey = ? ORDER BY name')
      .all(accountKey) as unknown as SaveEntry[];
  }
  used(accountKey: string): number {
    return this.list(accountKey).reduce((a, f) => a + f.size, 0);
  }
  has(accountKey: string, name: string): boolean {
    return this.list(accountKey).some((f) => f.name === name);
  }
  put(accountKey: string, e: SaveEntry): void {
    this.db
      .prepare('INSERT OR REPLACE INTO player_saves (accountKey, name, size, mtime) VALUES (?, ?, ?, ?)')
      .run(accountKey, e.name, e.size, e.mtime);
  }
  remove(accountKey: string, name: string): void {
    this.db.prepare('DELETE FROM player_saves WHERE accountKey = ? AND name = ?').run(accountKey, name);
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
  const keyOf = (account: string, name: string): string => `saves/${account}/${name}`;

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
      if (req.method === 'GET' && url.pathname === '/saves') {
        json(res, 200, { files: store.list(accountKey), quota: deps.maxBytesPerAccount });
        return true;
      }

      if (req.method === 'POST' && url.pathname === '/saves/authorize-upload') {
        const body = await readBody(req);
        const name = saveName(body.name);
        const size = typeof body.size === 'number' && Number.isFinite(body.size) && body.size >= 0
          ? Math.floor(body.size) : undefined;
        if (!name || size === undefined) { json(res, 400, { error: 'bad_save' }); return true; }
        // Replacing a slot frees its old bytes, so charge only the difference.
        const prior = store.list(accountKey).find((f) => f.name === name)?.size ?? 0;
        if (store.used(accountKey) - prior + size > deps.maxBytesPerAccount) {
          json(res, 200, { ok: false, reason: 'quota' });
          return true;
        }
        json(res, 200, { ok: true, url: await deps.storage.presignPut(keyOf(accountKey, name), size) });
        return true;
      }

      if (req.method === 'POST' && url.pathname === '/saves/uploaded') {
        const body = await readBody(req);
        const name = saveName(body.name);
        const size = typeof body.size === 'number' ? Math.floor(body.size) : undefined;
        if (!name || size === undefined) { json(res, 400, { error: 'bad_save' }); return true; }
        const mtime = typeof body.mtime === 'number' && Number.isFinite(body.mtime)
          ? Math.floor(body.mtime) : Date.now();
        store.put(accountKey, { name, size, mtime });
        return json(res, 200, { ok: true }), true;
      }

      if (req.method === 'GET' && url.pathname === '/saves/download') {
        const name = saveName(url.searchParams.get('name'));
        // Not in YOUR list is 404 whether or not it exists for somebody else.
        if (!name || !store.has(accountKey, name)) { json(res, 404, { error: 'not_yours' }); return true; }
        json(res, 200, { url: await deps.storage.presignGet(keyOf(accountKey, name)) });
        return true;
      }

      if (req.method === 'POST' && url.pathname === '/saves/delete') {
        const name = saveName((await readBody(req)).name);
        if (!name || !store.has(accountKey, name)) { json(res, 404, { error: 'not_yours' }); return true; }
        await deps.storage.delete(keyOf(accountKey, name));
        store.remove(accountKey, name);
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
  const n = store.list(accountKey).length;
  await storage?.delete(`saves/${accountKey}/`);
  for (const f of store.list(accountKey)) store.remove(accountKey, f.name);
  return n;
}
