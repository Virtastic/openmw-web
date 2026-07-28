// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 3.5: the storage locker's HTTP surface.
//
//   POST /locker/attest            record the ownership attestation (before any bytes)
//   POST /locker/authorize-upload  -> presigned PUT for one recognized file, or a refusal
//   POST /locker/uploaded          confirm a file landed (records it in the manifest)
//   GET  /locker/files             list this account's stored files
//   GET  /locker/download?name=    -> presigned GET (owner only)
//   POST /locker/erase             delete-my-data
//
// AUTH is a locker session, NOT the game's WebSocket session: the whole point is to upload
// your data BEFORE you can join a world. The SSO callback mints a locker session and drops
// it as an httpOnly cookie (auth/routes.ts), so these routes read the caller's account
// from that cookie — never from the request body, which a client could forge.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Locker, LockerFile } from './locker';
import { readCookie } from '../net/http';
import { log } from '../log';

const LOCKER_COOKIE = 'omw_locker';

export interface LockerSessions {
  resolve(token: string): string | undefined; // token -> accountKey
}

export interface LockerRouteDeps {
  locker: Locker;
  sessions: LockerSessions;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

async function readBody(req: IncomingMessage, limit = 65536): Promise<unknown> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('too large');
  }
  return JSON.parse(body || '{}');
}

function parseFile(v: unknown): LockerFile | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string' || o.name === '' || o.name.length > 256) return undefined;
  if (typeof o.size !== 'number' || !Number.isFinite(o.size) || o.size < 0) return undefined;
  if (typeof o.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(o.sha256)) return undefined;
  // No path traversal into another account's prefix, ever.
  if (o.name.includes('..') || o.name.includes('\0')) return undefined;
  return { name: o.name, size: o.size, sha256: o.sha256 };
}

export function lockerRoutes(deps: LockerRouteDeps) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (!url.pathname.startsWith('/locker/')) return false;
    if (!deps.locker.enabled) {
      json(res, 503, { error: 'locker_disabled' }); // no storage configured
      return true;
    }
    const accountKey = deps.sessions.resolve(readCookie(req, LOCKER_COOKIE) ?? '');
    if (!accountKey) {
      json(res, 401, { error: 'sign_in_first' });
      return true;
    }

    try {
      if (req.method === 'POST' && url.pathname === '/locker/attest') {
        const body = (await readBody(req)) as { files?: unknown };
        const files = Array.isArray(body.files) ? body.files.map(parseFile) : [];
        if (files.some((f) => f === undefined)) { json(res, 400, { error: 'bad_files' }); return true; }
        const att = await deps.locker.attest(accountKey, files as LockerFile[], clientIp(req));
        json(res, 200, { ok: true, statement: att.statement, at: att.at });
        return true;
      }

      if (req.method === 'POST' && url.pathname === '/locker/authorize-upload') {
        const file = parseFile((await readBody(req)) as unknown);
        if (!file) { json(res, 400, { error: 'bad_file' }); return true; }
        const r = await deps.locker.authorizeUpload(accountKey, file);
        if (!r.ok) { json(res, 200, { ok: false, reason: r.reason }); return true; }
        json(res, 200, { ok: true, url: r.url, key: r.key });
        return true;
      }

      if (req.method === 'POST' && url.pathname === '/locker/uploaded') {
        const file = parseFile((await readBody(req)) as unknown);
        if (!file) { json(res, 400, { error: 'bad_file' }); return true; }
        await deps.locker.recordUploaded(accountKey, file);
        json(res, 200, { ok: true });
        return true;
      }

      if (req.method === 'GET' && url.pathname === '/locker/files') {
        json(res, 200, { files: await deps.locker.filesOf(accountKey) });
        return true;
      }

      if (req.method === 'GET' && url.pathname === '/locker/download') {
        const name = url.searchParams.get('name') ?? '';
        const dl = await deps.locker.authorizeDownload(accountKey, name);
        if (!dl) { json(res, 404, { error: 'not_yours' }); return true; }
        json(res, 200, { url: dl });
        return true;
      }

      if (req.method === 'POST' && url.pathname === '/locker/erase') {
        await deps.locker.erase(accountKey);
        json(res, 200, { ok: true });
        return true;
      }

      json(res, 404, { error: 'not_found' });
      return true;
    } catch (err) {
      log('error', 'locker.route_threw', { path: url.pathname, error: String(err) });
      json(res, 500, { error: 'internal' });
      return true;
    }
  };
}

function clientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? '';
}

export { LOCKER_COOKIE };
