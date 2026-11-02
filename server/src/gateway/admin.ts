// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The multiplayer server's dashboard.
//
// The same page (web/app.js) and the same route table (net/admin/routes.ts) a game serves,
// mounted on the multiplayer server with deps that answer for the PLATFORM: who is playing
// and in whose game, how full the box is, the shared account store, the shared settings every
// game starts from. Nothing here is a second dashboard — it is the one dashboard, told which
// process it is running in.
//
// Things this file owns:
//
//   *    /admin/api/world/<anything>      THE PROXY: the world's own /admin/api/<anything>
//
// OT3-37: no route here stops or discards the world, and the rolling restart is the world's
// own (POST /admin/api/peers/rolling-restart, one region peer at a time), reached by proxy.
//
// THE PROXY IS HOW THE ONE SIGN-IN REACHES THE WORLD (OT3-64: there is one world, so there is
// no game to pick). Admin sessions live in memory per process, so the world process cannot
// recognise the operator's token. The hop is authenticated with the platform credential the
// world already loads, [gateway].serverToken, and the operator's identity and role travel in
// headers; the world accepts that pair from loopback only (see gatewayPrincipal in
// net/admin/auth.ts) and audits the request under the operator's name.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config';
import { defaultClientDir } from '../net/client-routes';
import { roleAtLeast, type AccountStore } from '../core/accounts';
import type { AdminSessionStore } from '../auth/identities';
import { Moderation, reportView } from '../core/moderation';
import { gameDataDir } from '../core/gamedata';
import { deleteAccount } from '../persist/erase';
import { operatorRank, PLATFORM_ACTOR } from '../core/admin';
import { BanStore } from '../persist/banstore';
import { log, logHistory } from '../log';
import { IpRateLimiter } from '../net/ratelimit';
import { clientIp, CLIENT_IP_HEADER, type HttpRoute } from '../net/http';
import { adminRoutes, type AdminDeps } from '../net/admin/routes';
import { gate, GATEWAY_ACTOR_HEADERS, type AuthContext, type AuthDeps } from '../net/admin/auth';
import { json } from '../net/admin/util';
import { SetupToken } from '../net/admin/setup-token';
import { createSysInfo } from '../net/admin/sysinfo';
import { exportDataDir, summariseMetrics } from '../net/admin/ops';
import { passwordReset } from '../net/admin/reset';
import type { WorldSupervisor, WorldInfo } from './worlds';

interface GatewayAdminDeps {
  worlds: WorldSupervisor;
  sharedDir: string;
  /** Re-read each call, like a game's: the settings page shows what a restart would load. */
  config: () => Config;
  accounts: AccountStore;
  sessions: AdminSessionStore;
  version: string;
  /** The origin password-reset links open on. */
  publicBase: () => string;
  saveStorage?: AdminDeps['saveStorage'];
  restart: (reason: string) => void;
  maintenance: AdminDeps['maintenance'];
}

/** The one world, as the dashboard's World health card shows it (OT3-34). */
interface WorldCard {
  id: string;
  up: boolean;
  name: string;
  playerCount: number;
  connectedCount: number;
  maxPlayers: number;
  peerCount: number;
  uptime: number;
  pid: number | null;
  blockedUntil: number | null;
  fastCrashes: number;
  players: WorldInfo['players'];
}

export function gatewayAdminRoutes(deps: GatewayAdminDeps): HttpRoute {
  const startedAt = Date.now();
  const sysInfo = createSysInfo(deps.sharedDir);
  // Reports are shared: a report filed in any game lands in the same queue, so the platform
  // serves them directly rather than asking each game.
  const moderation = new Moderation(deps.sharedDir, deps.config().moderation);
  const setupToken = new SetupToken(deps.sharedDir);
  if (!deps.accounts.hasDashboardOwner()) setupToken.arm();
  const token = (): string => deps.config().gateway.serverToken;

  const worldCard = (g: WorldInfo, now: number): WorldCard => {
    return {
      id: g.id,
      up: g.up,
      name: g.name,
      playerCount: g.playerCount,
      connectedCount: g.connectedCount,
      maxPlayers: g.maxPlayers,
      peerCount: g.peerCount,
      uptime: Math.round((now - g.startedAt) / 1000),
      pid: g.pid ?? null,
      blockedUntil: g.blockedUntil ?? null,
      fastCrashes: g.fastCrashes,
      players: g.players,
    };
  };
  const theWorld = (): WorldCard | null => {
    const w = deps.worlds.list()[0];
    return w ? worldCard(w, Date.now()) : null;
  };

  const refuse = { ok: false, message: 'This acts on players in the world: use the Players page, which goes to the world process.' };

  const base = adminRoutes({
    dataDir: deps.sharedDir,
    sharedDir: deps.sharedDir,
    platform: true,
    config: deps.config,
    accounts: deps.accounts,
    sessions: deps.sessions,
    loginLimiter: new IpRateLimiter(deps.config().limits.loginPerMinPerIp),
    apiLimiter: new IpRateLimiter(600),
    sharedToken: deps.config().admin.dashboardToken,
    setupToken,
    gameDataDir: gameDataDir(deps.sharedDir),
    version: deps.version,
    clientDir: existsSync(defaultClientDir()) ? defaultClientDir() : undefined,

    // PEOPLE FIRST: who is playing, then the world process and the box's health.
    overview: async (role) => {
      const now = Date.now();
      const cfg = deps.config();
      const world = theWorld();
      return {
        platform: true,
        uptime: Math.round((now - startedAt) / 1000),
        system: await sysInfo(),
        // One world (OT3-34): its health card, or null before it has started.
        world: world && { ...world, players: undefined },
        players: world?.players ?? [],
      };
    },
    reports: async (limit) => ({
      reports: (await moderation.reports.list(Math.min(Math.max(1, limit || 20), 100))).map(reportView),
    }),
    // Bans live in the SHARED bans.db, so lifting one needs no game: a fresh store reads
    // the db as it is now (a long-lived one would only know the bans it booted with).
    // Every other kind acts on the players of one game, and stays refused here.
    action: async (kind, target, _detail, by) => {
      if (kind !== 'unban') return refuse;
      // OT3-191: the world's /unban is rank 2; the platform-level one is no looser.
      if (await operatorRank(deps.accounts, by) < 2) return { ok: false, message: '/unban requires rank 2 (admin).' };
      const bans = new BanStore(deps.sharedDir);
      const lifted = bans.unbanAccount(target);
      await bans.close();
      if (lifted) log('info', 'moderation.unban', { target: target.toLowerCase(), by });
      return { ok: lifted, message: lifted ? `unban ${target}` : `${target} was not banned` };
    },
    runCommand: async () => refuse,
    commandCatalog: () => [],
    // Ring plus on-disk history: world.* and gateway.* lifecycle events survive a restart.
    recentLogs: (limit, filter) => logHistory(limit, filter),
    metricsSnapshot: () => summariseMetrics(),
    maintenance: deps.maintenance,
    restart: deps.restart,
    exportData: async (res) => exportDataDir(deps.sharedDir, res),
    deleteAccount: async (key) => {
      // Same order as the single-world path (server.ts): cut the live sessions, drain the
      // write-behind, then erase. Here the sessions live in the WORLDS, so every running
      // game is told to kick; and the character's solo world is retired, or its next flush
      // wrote the character straight back (the row without a slot that #188 found).
      const account = await deps.accounts.get(key);
      const h = GATEWAY_ACTOR_HEADERS;
      await Promise.all(deps.worlds.list().filter((w) => w.up).map((g) =>
        fetch(`http://127.0.0.1:${g.port}/admin/api/action`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token()}`,
            [h.key]: PLATFORM_ACTOR, [h.name]: PLATFORM_ACTOR, [h.role]: 'owner',
          },
          body: JSON.stringify({ kind: 'kick', target: key, detail: 'account erased' }),
          signal: AbortSignal.timeout(3000),
        }).catch((err) => log('warn', 'admin.erase_kick_failed', { game: g.id, error: String(err) }))));
      await deps.accounts.flush();
      const report = await deleteAccount(deps.sharedDir, key);
      if (!report.account && !report.player) return { ok: false, message: 'nothing found under that name' };
      return {
        ok: true,
        message: `erased ${key}: account=${report.account} character=${report.player} `
          + `bans=${report.bans} identities=${report.identities}`,
      };
    },
    ...(deps.saveStorage ? { saveStorage: deps.saveStorage } : {}),
    maxSaveBytesPerAccount: deps.config().locker.maxSaveBytesPerAccount,
    mailConfigured: () => deps.config().notifications.smtpHost !== '',
    ...passwordReset({
      accounts: deps.accounts,
      sessions: deps.sessions,
      mail: () => {
        const n = deps.config().notifications;
        return { host: n.smtpHost, port: n.smtpPort, user: n.smtpUser, pass: n.smtpPass, from: n.from };
      },
      base: deps.publicBase,
      serverName: () => deps.config().server.name,
    }),
  });

  const auth: AuthDeps = {
    sharedToken: deps.config().admin.dashboardToken,
    accounts: deps.accounts,
    sessions: deps.sessions,
    loginLimiter: new IpRateLimiter(deps.config().limits.loginPerMinPerIp),
    apiLimiter: new IpRateLimiter(600),
  };

  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const path = url.pathname;

    if (path === '/admin/api/world' || path.startsWith('/admin/api/world/')) {
      // The world's own API. The role check is viewer HERE (is this a signed-in operator at
      // all); the world applies its own per-route role to the one forwarded in the headers.
      const ctx = await gate(req, res, auth, 'viewer');
      if (!ctx) return true;
      const world = deps.worlds.list()[0];
      if (!world || !world.up) {
        json(res, 502, { error: 'The world is not running right now. It starts again when somebody plays.' });
        return true;
      }
      proxy(req, res, world.port, `/admin/api/${path.slice('/admin/api/world/'.length)}${url.search}`, ctx, token());
      return true;
    }
    return base(req, res, url);
  };
}

/**
 * One request, replayed against the game on loopback. Bodies are piped, not buffered: mod
 * uploads go through here too, and a several-hundred-megabyte archive is not a JSON body.
 * Client-supplied copies of the actor headers are dropped first, or the headers would be a
 * way for a signed-in viewer to name themselves owner.
 */
function proxy(
  req: IncomingMessage, res: ServerResponse, port: number, path: string,
  ctx: AuthContext, serverToken: string,
): void {
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || k === 'host' || k === 'authorization' || k.startsWith('x-omw-')) continue;
    headers[k] = v;
  }
  headers.host = `127.0.0.1:${port}`;
  headers.authorization = `Bearer ${serverToken}`;
  headers[GATEWAY_ACTOR_HEADERS.key] = ctx.accountKey;
  headers[GATEWAY_ACTOR_HEADERS.name] = ctx.accountName;
  headers[GATEWAY_ACTOR_HEADERS.role] = ctx.role;
  // The game sees a loopback socket; without this every operator shares one address for
  // its rate limits. Same header, same trust rule, as the WebSocket splice in directory.ts.
  headers[CLIENT_IP_HEADER] = clientIp(req);
  const up = httpRequest({ host: '127.0.0.1', port, method: req.method, path, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', (err) => {
    log('warn', 'admin.proxy_failed', { port, path, error: String(err) });
    if (!res.headersSent) json(res, 502, { error: 'That game stopped answering.' });
    else res.end();
  });
  req.pipe(up);
}

/**
 * PLATFORM-WIDE MAINTENANCE. A game's own switch closes one game's doors; this one closes
 * all of them: the directory refuses new dials and new games while it is on (directory.ts
 * reads `get`), and every running game is handed the same switch through the proxy
 * principal so it disconnects its players with the same message. Persisted beside the
 * shared config for the same reason a game persists its own — "turn it on, change
 * settings, restart" is the whole use, and a restart must not switch it off.
 */
export function platformMaintenance(deps: {
  worlds: WorldSupervisor; sharedDir: string; worldsDir: string; token: () => string;
}): AdminDeps['maintenance'] {
  const file = join(deps.sharedDir, 'maintenance');
  const state = { on: false, message: '' };
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { on?: boolean; message?: string };
    state.on = saved.on === true;
    state.message = String(saved.message ?? '');
    if (state.on) log('warn', 'gateway.maintenance_restored', { message: state.message });
  } catch { /* no marker: not in maintenance, the common case */ }
  return {
    get: () => ({ on: state.on, message: state.message }),
    set: (on, message) => {
      state.on = on;
      state.message = message;
      try {
        if (on) writeFileSync(file, JSON.stringify(state));
        else rmSync(file, { force: true });
      } catch (e) {
        log('warn', 'gateway.maintenance_persist_failed', { error: String(e) });
      }
      const h = GATEWAY_ACTOR_HEADERS;
      for (const g of deps.worlds.list().filter((w) => w.up)) {
        void fetch(`http://127.0.0.1:${g.port}/admin/api/maintenance`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${deps.token()}`,
            [h.key]: '(platform)', [h.name]: 'the multiplayer server', [h.role]: 'owner',
          },
          body: JSON.stringify({ on, message }),
          signal: AbortSignal.timeout(3000),
        }).catch((err) => log('warn', 'gateway.maintenance_relay_failed', { game: g.id, error: String(err) }));
      }
      // A game that was reaped while maintenance was on kept its own marker; clear those too,
      // or it comes back on its owner's next dial with doors that never reopen.
      if (!on && existsSync(deps.worldsDir)) {
        for (const dir of readdirSync(deps.worldsDir)) {
          try { rmSync(join(deps.worldsDir, dir, 'maintenance'), { force: true }); } catch { /* not ours to fix */ }
        }
      }
    },
  };
}
