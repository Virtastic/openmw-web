// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// F3 — the directory a client talks to before it knows which world to dial.
//
// Deliberately small and deliberately NOT a proxy. It hands back a host:port and the client
// connects straight to that world. Proxying every frame through a gateway would put the
// whole platform's movement traffic through one Node event loop, which is exactly the
// bottleneck process-per-world exists to avoid.
//
//   GET  /worlds            list joinable worlds (public always; private/party by owner)
//   POST /worlds            create-or-join a private/party world, returns where to dial
//   GET  /worlds/:id        one world
//   GET  /healthz
//
// AUTH IS NOT DONE HERE and this is important: the gateway does not verify accounts. Each
// world already authenticates on its own WebSocket (SessionHello -> Authing), so a client
// that learns a port still cannot join without credentials. What the gateway must not do is
// LEAK private world ids to people who were not invited, which is why listing filters on the
// caller-supplied account and why that is only a listing filter, never an access control.

import { createServer, type Server, type ServerResponse } from 'node:http';
import { log } from '../log';
import type { WorldSupervisor, WorldMode } from './worlds';
import type { HttpRoute } from '../net/http';

export interface DirectoryDeps {
  worlds: WorldSupervisor;
  host: string;
  port: number;
  // The host clients should dial for a world. Not necessarily this process's host: in
  // production the worlds sit behind the same public name on different ports/paths.
  publicHost: string;
  maxPerOwner: number;
  // F3 front door: SSO (/auth/*) and locker (/locker/*). Tried before the /worlds routes so the
  // browser has a single public endpoint for sign-in, upload, and world selection. Optional so
  // a bare directory (no SSO/locker) still runs.
  frontDoor?: HttpRoute;
}

export interface RunningDirectory {
  port: number;
  close: () => Promise<void>;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

export async function startDirectory(deps: DirectoryDeps): Promise<RunningDirectory> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // Front door first: /auth/* and /locker/* are handled by the shared SSO + locker services.
    if (deps.frontDoor && (path.startsWith('/auth/') || path.startsWith('/locker/'))) {
      void Promise.resolve(deps.frontDoor(req, res, url)).then((claimed) => {
        if (!claimed) { json(res, 404, { error: 'not found' }); }
      }).catch(() => { if (!res.headersSent) json(res, 500, { error: 'internal' }); });
      return;
    }

    if (req.method === 'GET' && path === '/healthz') {
      json(res, 200, { ok: true, worlds: deps.worlds.running });
      return;
    }

    if (req.method === 'GET' && path === '/worlds') {
      // A private/party world is listed only to its owner. This is a VISIBILITY filter to
      // avoid advertising other people's sessions — the world's own auth is what actually
      // protects it.
      const account = url.searchParams.get('account') ?? undefined;
      const list = deps.worlds.list().filter((w) =>
        w.mode === 'public' || (account !== undefined && w.ownerAccount === account));
      json(res, 200, { worlds: list.map((w) => ({ ...w, host: deps.publicHost })) });
      return;
    }

    if (req.method === 'GET' && path.startsWith('/worlds/')) {
      const id = decodeURIComponent(path.slice('/worlds/'.length));
      const w = deps.worlds.get(id);
      if (!w) { json(res, 404, { error: 'no such world' }); return; }
      json(res, 200, { ...w, host: deps.publicHost });
      return;
    }

    if (req.method === 'POST' && path === '/worlds') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 4096) req.destroy(); // a create request is tiny; anything else is abuse
      });
      req.on('end', () => {
        let parsed: { id?: string; mode?: string; account?: string };
        try { parsed = JSON.parse(body || '{}'); } catch { json(res, 400, { error: 'bad json' }); return; }
        const mode = parsed.mode;
        if (mode !== 'private' && mode !== 'party') {
          // Public worlds are operator configuration, not something a client may conjure.
          json(res, 400, { error: 'mode must be private or party' });
          return;
        }
        const account = parsed.account;
        if (!account) { json(res, 400, { error: 'account required' }); return; }
        const id = parsed.id && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(parsed.id) ? parsed.id : undefined;
        if (!id) { json(res, 400, { error: 'id must be [a-z0-9_-], 1-64 chars' }); return; }

        // Per-owner cap: without it one account can exhaust maxWorlds and deny everyone
        // else. Counted over worlds this owner already has, and an existing world is a
        // re-join rather than a create, so it never trips on reconnect.
        const mine = deps.worlds.list().filter((w) => w.ownerAccount === account);
        if (!mine.some((w) => w.id === id) && mine.length >= deps.maxPerOwner) {
          json(res, 429, { error: `at most ${deps.maxPerOwner} sessions per account` });
          return;
        }

        const world = deps.worlds.ensure(id, mode as WorldMode, account);
        if (!world) { json(res, 503, { error: 'no capacity for another world right now' }); return; }
        json(res, 200, { ...world, host: deps.publicHost });
      });
      return;
    }

    json(res, 404, { error: 'not found' });
  });

  await new Promise<void>((resolve) => server.listen(deps.port, deps.host, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : deps.port;
  log('info', 'directory.start', { port, publicHost: deps.publicHost });

  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
