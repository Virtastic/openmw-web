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
import { connect as netConnect } from 'node:net';
import { clientIp, CLIENT_IP_HEADER } from '../net/ws';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../log';
import type { WorldSupervisor, WorldMode } from './worlds';
import type { HttpRoute } from '../net/http';

export interface DirectoryDeps {
  worlds: WorldSupervisor;
  host: string;
  port: number;
  maxPerOwner: number;
  // Where world data dirs live. Used to revive a world that exists on disk but is not
  // running: the directory's EXISTENCE is the proof it is a real world, which is what stops
  // a dialled /w/priv-anything from spawning one.
  worldsDir: string;
  // F3 front door: SSO (/auth/*) and locker (/locker/*). Tried before the /worlds routes so the
  // browser has a single public endpoint for sign-in, upload, and world selection. Optional so
  // a bare directory (no SSO/locker) still runs.
  frontDoor?: HttpRoute;
  // Bearer token -> account key. POST /worlds spawns an OS process, so it must know WHO is
  // asking: the account used to come from the request body, so anyone could spawn worlds
  // under fabricated names until the global maxWorlds cap was gone, while every per-owner
  // limit read as satisfied. Absent = no verifier wired, and world creation is refused.
  resolveAccount?: (authorizationHeader: string) => string | undefined;
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
  // Clients dial wsPath on THIS origin — the only address they can reach, since a world's
  // port is internal and never published. So the projection deliberately does NOT carry an
  // address: `host` used to be a configured guess that defaulted to 127.0.0.1, which is a
  // remote player's OWN machine, and `port` advertised an internal port to everyone.
  // Nothing to configure, nothing to go stale, nothing leaked.
  const pub = <T extends { id: string; port: number }>(w: T): Omit<T, 'port'> & { wsPath: string } => {
    const { port: _internalPort, ...rest } = w;
    return { ...rest, wsPath: `/w/${w.id}` };
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // The game page is a DIFFERENT origin than this gateway, so every endpoint here is a
    // cross-origin API. Set CORS on all responses and answer the preflight — without this the
    // browser's POST /worlds (create-or-join) is blocked and shows only "Failed to fetch".
    res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
    // DELETE: character deletion (/auth/characters). The directory answers ALL preflights on
    // this port, so a method missing here is blocked by the browser before the front-door
    // route ever sees it — which read as "could not reach the server" on the delete button.
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Front door first: /auth/*, /locker/* and /saves are handled by the shared SSO, locker
    // and savegame services. This list is the real router — a path the front door implements
    // but that is missing HERE falls through to the 404 below, which is how server-side saves
    // reached the gateway and were answered "not found" with the locker working fine beside
    // them. Add the prefix here as well as mounting the route.
    if (deps.frontDoor && (path.startsWith('/auth/') || path.startsWith('/locker/')
        || path === '/saves' || path.startsWith('/saves/'))) {
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
      json(res, 200, { worlds: list.map(pub) });
      return;
    }

    if (req.method === 'GET' && path.startsWith('/worlds/')) {
      const id = decodeURIComponent(path.slice('/worlds/'.length));
      const w = deps.worlds.get(id);
      if (!w) { json(res, 404, { error: 'no such world' }); return; }
      json(res, 200, pub(w));
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
        // The SESSION says who this is, never the message. A client-supplied account here
        // made the per-owner cap decorative: fabricate a new name per request and one caller
        // exhausts every world slot on the host, each holding its slot for the full startup
        // grace, locking real players out with 503s.
        const account = deps.resolveAccount?.(req.headers.authorization ?? '');
        if (!account) { json(res, 401, { error: 'sign_in_first' }); return; }
        const id = parsed.id && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(parsed.id) ? parsed.id : undefined;
        if (!id) { json(res, 400, { error: 'id must be [a-z0-9_-], 1-64 chars' }); return; }

        // Per-owner cap: without it one account can exhaust maxWorlds and deny everyone
        // else. Counted over worlds this owner already has, and an existing world is a
        // re-join rather than a create, so it never trips on reconnect.
        //
        // ABANDONED worlds do not count. A world id is per character, so deleting a character
        // and creating another asks for a new world each time, and the played-then-left worlds
        // behind you were still counted — which locked the account out with a 429 after two
        // characters. They are reaped shortly anyway; they must not block a live session first.
        // A world that was JUST created and not yet joined still counts, so the cap keeps
        // doing its job of stopping one account exhausting maxWorlds.
        const mine = deps.worlds.list()
          .filter((w) => w.ownerAccount === account && !w.abandoned);
        if (!mine.some((w) => w.id === id) && mine.length >= deps.maxPerOwner) {
          json(res, 429, { error: `at most ${deps.maxPerOwner} sessions per account` });
          return;
        }

        const world = deps.worlds.ensure(id, mode as WorldMode, account);
        if (!world) { json(res, 503, { error: 'no capacity for another world right now' }); return; }
        json(res, 200, pub(world));
      });
      return;
    }

    json(res, 404, { error: 'not found' });
  });

  // WORLD TRAFFIC ON ONE PORT.
  //
  // Every world is its own process on its own port (basePort + n). Publishing 32 ports is
  // unworkable in production: Cloudflare only proxies a fixed set, and the edge reaches this
  // container over the docker network with NO published host ports at all (deploy/
  // openmw-mp.caddy: `reverse_proxy openmw-mp:8080`). So worlds were simply unreachable
  // outside local dev — the multi-world architecture had never actually worked in production.
  //
  // Fix: clients dial `/w/<worldId>` on the gateway and we splice them through to the world's
  // loopback port. World ports never leave the container.
  //
  // A raw socket pipe, not a WebSocket library: this is a byte stream after the handshake, so
  // re-framing it would cost CPU and add a place for the protocol to be subtly wrong. The
  // original upgrade request is replayed verbatim and both directions are piped.
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const m = /^\/w\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/.exec(path);
    let world = m ? deps.worlds.get(m[1]!) : undefined;
    // RESTART A KNOWN WORLD ON DIAL. A private world is only started when the launcher asks
    // for it, so after a gateway restart (or an idle reap) a client reconnecting to its own
    // world found nothing here, got a 502, and retried forever — the world sat on disk the
    // whole time. The world id encodes its owner and the world itself still authorises the
    // arrival (mayJoinWorld), so bringing it back costs nothing a launcher request would not.
    if (!world && m && /^priv-/.test(m[1]!) && existsSync(join(deps.worldsDir, m[1]!))) {
      world = deps.worlds.ensure(m[1]!, 'private') ?? undefined;
      if (world) log('info', 'world.revived_on_dial', { id: m[1] });
    }
    if (!world || !world.up) {
      // A world that is down must fail the handshake, not hang: the client's own retry ladder
      // is what recovers, and it can only run if the socket closes.
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = netConnect({ host: '127.0.0.1', port: world.port }, () => {
      // Replay the handshake byte for byte, including anything already buffered in `head` —
      // but STAMP the real client address. After this splice the world sees a loopback socket,
      // so without it every client behind the gateway shares one address: maxConnsPerIp
      // becomes a whole-world cap (three sockets from one attacker locks everyone out) and IP
      // bans stop matching anyone. cf-connecting-ip only exists on Cloudflare; this works for
      // any front end.
      //
      // A client-supplied copy is DROPPED first, or the header would be a trivial way to forge
      // an address and evade both the cap and a ban. The world only trusts it from loopback.
      const headers = Object.entries(req.headers)
        .filter(([k]) => k.toLowerCase() !== CLIENT_IP_HEADER)
        .map(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`).join('\r\n') : `${k}: ${v}`))
        .join('\r\n');
      const realIp = clientIp(req);
      upstream.write(`GET /ws HTTP/1.1\r\n${headers}\r\n${CLIENT_IP_HEADER}: ${realIp}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const bail = (): void => { try { upstream.destroy(); } catch { /* already gone */ } socket.destroy(); };
    upstream.on('error', bail);
    socket.on('error', bail);
  });

  await new Promise<void>((resolve) => server.listen(deps.port, deps.host, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : deps.port;
  log('info', 'directory.start', { port });

  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
