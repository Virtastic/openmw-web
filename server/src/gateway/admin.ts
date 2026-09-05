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
// Three things are this file's own:
//
//   GET  /admin/api/games                 the games, with owner names and process detail
//   POST /admin/api/games/:id/stop        [owner] stop one game (revive-on-dial brings it back)
//   POST /admin/api/games/:id/discard     [owner] stop it and delete its data (type-to-confirm)
//   POST /admin/api/rolling-restart       [owner] restart every game one at a time
//   *    /admin/api/games/:id/<anything>  THE PROXY: that game's own /admin/api/<anything>
//
// THE PROXY IS HOW ONE SIGN-IN REACHES EVERY GAME. Admin sessions live in memory per process,
// so a game cannot recognise the operator's token. The hop is authenticated with the
// platform credential every game already loads, [gateway].serverToken, and the operator's
// identity and role travel in headers; the game accepts that pair from loopback only (see
// gatewayPrincipal in net/admin/auth.ts) and audits the request under the operator's name.
// Every per-game page — roster, moderation, chat log, quests, mods, game files, the game's
// own settings — keeps working unchanged behind it.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config';
import type { AccountStore } from '../core/accounts';
import type { AdminSessionStore } from '../auth/identities';
import { Moderation } from '../core/moderation';
import { gameDataDir } from '../core/gamedata';
import { deleteAccount } from '../persist/erase';
import { log, logHistory } from '../log';
import { IpRateLimiter } from '../net/ratelimit';
import { clientIp, CLIENT_IP_HEADER, type HttpRoute } from '../net/http';
import { adminRoutes, type AdminDeps } from '../net/admin/routes';
import { gate, GATEWAY_ACTOR_HEADERS, type AuthContext, type AuthDeps } from '../net/admin/auth';
import { json, readJson } from '../net/admin/util';
import { SetupToken } from '../net/admin/setup-token';
import { createSysInfo } from '../net/admin/sysinfo';
import { exportDataDir, summariseMetrics } from '../net/admin/ops';
import { passwordReset } from '../net/admin/reset';
import type { WorldSupervisor, WorldInfo } from './worlds';

export interface GatewayAdminDeps {
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
  /** 'busy' while a roll is already in flight; otherwise the roll, which may take minutes. */
  rollingRestart: () => Promise<{ restarted: string[]; failed: string[] }> | 'busy';
  maintenance: AdminDeps['maintenance'];
}

/** A game as the dashboard shows it: the owner's NAME first, the id alongside. */
export interface GameRow {
  id: string;
  mode: string;
  up: boolean;
  abandoned: boolean;
  owner: string | null;
  ownerName: string | null;
  /** "Michael's game", or the game's own name when it has no owner on record. */
  label: string;
  playerCount: number;
  connectedCount: number;
  maxPlayers: number;
  peerCount: number;
  uptime: number;
  /** Seconds until the reaper takes an empty game, or null while someone is in it. */
  reapsInSec: number | null;
  pid: number | null;
  blockedUntil: number | null;
  fastCrashes: number;
  players: WorldInfo['players'];
}

const GAME_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function gatewayAdminRoutes(deps: GatewayAdminDeps): HttpRoute {
  const startedAt = Date.now();
  const sysInfo = createSysInfo(deps.sharedDir);
  // Reports are shared: a report filed in any game lands in the same queue, so the platform
  // serves them directly rather than asking each game.
  const moderation = new Moderation(deps.sharedDir, deps.config().moderation);
  const setupToken = new SetupToken(deps.sharedDir);
  if (!deps.accounts.hasDashboardOwner()) setupToken.arm();
  const token = (): string => deps.config().gateway.serverToken;

  const gameRow = (g: WorldInfo, now: number): GameRow => {
    const ownerName = g.ownerAccount
      ? (deps.accounts.cachedByKey(g.ownerAccount)?.username ?? g.ownerAccount)
      : null;
    return {
      id: g.id,
      mode: g.mode,
      up: g.up,
      abandoned: g.abandoned,
      owner: g.ownerAccount ?? null,
      ownerName,
      label: ownerName ? `${ownerName}'s game` : g.name,
      playerCount: g.playerCount,
      connectedCount: g.connectedCount,
      maxPlayers: g.maxPlayers,
      peerCount: g.peerCount,
      uptime: Math.round((now - g.startedAt) / 1000),
      reapsInSec: g.idleSince !== undefined && g.everConnected
        ? Math.max(0, Math.round((g.idleSince + deps.worlds.idleReapMs - now) / 1000))
        : null,
      pid: g.pid ?? null,
      blockedUntil: g.blockedUntil ?? null,
      fastCrashes: g.fastCrashes,
      players: g.players,
    };
  };
  const games = (): GameRow[] => {
    const now = Date.now();
    return deps.worlds.list().map((g) => gameRow(g, now));
  };

  const refuse = { ok: false, message: 'Open a game first: this acts on the players of one game, and the multiplayer server has none of its own.' };

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
    clientDir: existsSync('/client') ? '/client' : undefined,

    // PEOPLE FIRST. Rows are players, each labelled with whose game they are in; the games
    // and the box's health come after. This is the reading the page exists to give here,
    // and the one a single game's "World" card and player cap could never give.
    overview: async () => {
      const now = Date.now();
      const cap = deps.worlds.capacity();
      const cfg = deps.config();
      const rows = games();
      return {
        platform: true,
        uptime: Math.round((now - startedAt) / 1000),
        system: await sysInfo(),
        health: {
          games: deps.worlds.running,
          peers: deps.worlds.peersRunning,
          committedMb: deps.worlds.committed,
          budgetMb: cfg.worlds.memBudgetMb,
          capacity: Number.isFinite(cap.cap) ? cap.cap : null,
          capacityReason: cap.reason,
        },
        games: rows,
        players: rows.flatMap((g) => g.players.map((p) => ({
          ...p, game: g.id, gameLabel: g.label, gameMode: g.mode, owner: g.owner,
        }))),
      };
    },
    reports: async (limit) => ({
      reports: (await moderation.reports.list(Math.min(Math.max(1, limit || 20), 100))).map(({ doc }) => ({
        ts: doc.ts,
        reporter: doc.reporter.name,
        target: doc.target.name,
        reason: doc.reason,
      })),
    }),
    action: async () => refuse,
    runCommand: async () => refuse,
    commandCatalog: () => [],
    // Ring plus on-disk history: world.* and gateway.* lifecycle events survive a restart.
    recentLogs: (limit, filter) => logHistory(limit, filter),
    metricsSnapshot: () => summariseMetrics(),
    maintenance: deps.maintenance,
    restart: deps.restart,
    exportData: async (res) => exportDataDir(deps.sharedDir, res),
    deleteAccount: async (key) => {
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

  const GAME = /^\/admin\/api\/games\/([^/]+)(?:\/(.*))?$/;

  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/admin/api/games') {
      if (!await gate(req, res, auth, 'viewer')) return true;
      json(res, 200, { games: games() });
      return true;
    }
    if (method === 'POST' && path === '/admin/api/rolling-restart') {
      const ctx = await gate(req, res, auth, 'owner');
      if (!ctx) return true;
      const roll = deps.rollingRestart();
      if (roll === 'busy') { json(res, 409, { error: 'A rolling restart is already running.' }); return true; }
      log('warn', 'admin.rolling_restart', { by: ctx.accountKey, games: deps.worlds.running });
      // Answer NOW. A roll waits for each game to drain and come back, minutes for a busy
      // platform, and a request held open that long dies at the proxy. The outcome is in the
      // log (gateway.rolling_restart_done), and the games table shows it happening.
      json(res, 200, { ok: true, started: true, games: deps.worlds.running });
      return true;
    }

    const m = GAME.exec(path);
    if (m) {
      const id = m[1] ?? '';
      const rest = m[2] ?? '';
      if (!GAME_ID.test(id)) { json(res, 400, { error: 'not a game id' }); return true; }

      if (method === 'POST' && rest === 'stop') {
        const ctx = await gate(req, res, auth, 'owner');
        if (!ctx) return true;
        if (!deps.worlds.get(id)) { json(res, 404, { error: 'no such game' }); return true; }
        deps.worlds.stop(id);
        log('warn', 'admin.game_stopped', { by: ctx.accountKey, game: id });
        json(res, 200, { ok: true, message: `stopping ${id}; it comes back when its owner returns` });
        return true;
      }
      if (method === 'POST' && rest === 'discard') {
        const ctx = await gate(req, res, auth, 'owner');
        if (!ctx) return true;
        const body = await readJson<{ confirm?: string }>(req, res);
        if (body === undefined) return true;
        // Type-to-confirm, like account erasure: this deletes a game's data and a stray
        // click is a real failure mode in a browser.
        if (String(body.confirm ?? '') !== id) {
          json(res, 400, { error: 'confirmation did not match the game id' });
          return true;
        }
        const gone = await deps.worlds.discard(id, { by: ctx.accountKey });
        if (gone) log('warn', 'admin.game_discarded', { by: ctx.accountKey, game: id });
        json(res, gone ? 200 : 404, gone
          ? { ok: true, message: `discarded ${id}` }
          : { ok: false, error: 'no such game, running or on disk' });
        return true;
      }

      // Everything else is that game's own API. The role check is viewer HERE — is this a
      // signed-in operator at all — and the game applies its own per-route role to the one
      // forwarded in the headers, so a moderator gets exactly what a moderator gets on the
      // game directly.
      const ctx = await gate(req, res, auth, 'viewer');
      if (!ctx) return true;
      const game = deps.worlds.get(id);
      if (!game || !game.up) {
        json(res, 502, { error: 'That game is not running right now. It starts again when its owner comes back.' });
        return true;
      }
      proxy(req, res, game.port, `/admin/api/${rest}${url.search}`, ctx, token());
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
