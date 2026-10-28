// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// F3 entry point: run the world supervisor + directory.
//
//   node dist/gateway.mjs --worlds ./worlds --port 8080
//
// Separate from main.ts on purpose. A single world server must remain runnable on its own —
// that is what a self-hoster runs, what every test boots, and what the browser gate drives.
// The gateway is an ADDITION for operators running many worlds, never a required layer.

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORLD_ID, WorldSupervisor, reapOrphanWorlds } from './worlds';
import { startDirectory } from './directory';
import { buildFrontDoor } from './frontdoor';
import { gatewayAdminRoutes, platformMaintenance } from './admin';
import { AdminSessionStore } from '../auth/identities';
import { VERSION } from '../version';
import { notifyFromLog } from '../net/admin/notify';
import { loadConfig } from '../config';
import { HARNESS_PASSWORD } from '../auth/harness';
import { log, enableFileLog } from '../log';
import { metrics } from '../metrics';
import { mwDataRoutes } from '../net/mwdata-routes';
import { clientRoutes, defaultClientDir } from '../net/client-routes';
import { lockerPublicBase } from '../data/fsstorage';
import { writeCaddyfile } from '../net/admin/caddy-config';
import { gameDataDir } from '../core/gamedata';
import { presentMods, readModDoc } from '../core/mods';

const { values } = parseArgs({
  options: {
    worlds: { type: 'string' },
    port: { type: 'string' },
    'base-port': { type: 'string' },
    'max-worlds': { type: 'string' },
    'server-entry': { type: 'string' },
    shared: { type: 'string' },
  },
});

// A bad --max-worlds must not silently become NaN and disable the cap that stops one box
// spawning unbounded processes: Number('lots') is NaN, and every `>= maxWorlds` comparison
// against NaN is false.
function positiveInt(v: string | undefined, dflt: number, flag: string): number {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`invalid --${flag} ${v}: expected a positive integer`);
    process.exit(2);
  }
  return n;
}

const worldsDir = resolve(values.worlds ?? './worlds');
// Defaults to a sibling of the world dirs, so the common case needs no flag and shared
// state never lands INSIDE a world dir (where reaping that world could take it away).
const sharedDir = resolve(values.shared ?? join(worldsDir, '..', 'shared'));
// LIFECYCLE HISTORY ON DISK, like a game's. world.* and gateway.* events -- a game crashing
// three times and backing off, a roll halting -- were held only in this process's ring
// buffer and lost on restart, which is precisely when an operator wants to read them. Same
// sink, same rotation, same dashboard Logs page.
enableFileLog(sharedDir);
// One config drives the gateway and every world it spawns; read it once, here, so the
// capacity numbers below are derived from it rather than from parallel defaults.
const config = loadConfig(sharedDir, undefined, sharedDir);
const port = Number(values.port ?? 8080);
// ALERTS FROM THIS PROCESS TOO. The notifier was wired only inside a game, so the events
// that matter most to whoever runs the platform -- world.at_cap, world.crashloop,
// gateway.rolling_restart_halted, gateway.crash -- could never reach an inbox or a webhook.
// Same [notifications] config, same events list, same code.
const unhookNotifier = notifyFromLog(() => ({
  host: config.notifications.smtpHost,
  port: config.notifications.smtpPort,
  user: config.notifications.smtpUser,
  pass: config.notifications.smtpPass,
  from: config.notifications.from,
  to: config.notifications.to,
  webhookUrl: config.notifications.webhookUrl,
  events: config.notifications.events,
}));
// Default to the sibling server bundle, so a normal `dist/` layout needs no flag.
const serverEntry = resolve(values['server-entry']
  ?? join(dirname(fileURLToPath(import.meta.url)), 'server.mjs'));

if (!existsSync(serverEntry)) {
  // Fail at boot with the actual path. A gateway that starts and then cannot spawn anything
  // looks like "worlds keep crashing" and wastes an operator's afternoon.
  log('error', 'gateway.no_server_entry', { serverEntry });
  process.exit(1);
}

const worlds = new WorldSupervisor({
  settings: {
    worldsDir,
    serverEntry,
    nodeBin: process.execPath,
    basePort: Number(values['base-port'] ?? 9000),
    gatewayPort: port,
    // A count cap only. One public world runs; the cap is a backstop, not a plan.
    maxWorlds: positiveInt(values['max-worlds'], config.server.maxPlayers, 'max-worlds'),
    // 300 s, not 120: on the shared builder LXC a neighbour's load starves a world's boot for
    // tens of seconds at a time (mp-harness.mjs's own /healthz wait, #175 s117), and a rolling
    // restart used this same number to decide a world was gone (#175 s175: 120630 ms, one world
    // short of ready when the 120 s clock ran out).
    startTimeoutMs: 300_000,
    restartBackoffMs: 15_000,
    sharedDir,
  },
});

// Before anything binds a port: kill the world processes a previous gateway left behind. They
// still hold their ports, and allocPort cannot see them.
const orphans = await reapOrphanWorlds(worldsDir);
if (orphans > 0) log('warn', 'gateway.orphans_reaped', { count: orphans });

worlds.startPolling();
// Dashboard sessions, shared with the front door so SSO can sign an operator in here.
const adminSessions = new AdminSessionStore();
// The shared SSO + locker front door, on the same public port as the directory.
const frontDoor = await buildFrontDoor(sharedDir, undefined, port, adminSessions, () => worlds.list(), () => worlds.poll());

// ROLL THE WORLDS WITHOUT TAKING THE PLATFORM DOWN.
//
// WorldSupervisor.rollingRestart() was written, tested twice, and then reachable from nowhere:
// no route, no signal, no command. It has two callers now — SIGHUP, the ordinary idiom for
// "reload gracefully" from inside the container, and the dashboard's Rolling restart page.
//
// Guarded against overlap: a second request while a roll is in flight would interleave two
// sequences over the same worlds, and the "wait for the old process to exit" step of one would
// see the other's replacement and give up on it.
let rolling = false;
function requestRoll(): Promise<{ restarted: string[]; failed: string[] }> | 'busy' {
  if (rolling) {
    log('warn', 'gateway.rolling_restart_busy', {});
    return 'busy';
  }
  rolling = true;
  log('info', 'gateway.rolling_restart_requested', { worlds: worlds.running });
  return worlds.rollingRestart()
    .then((r) => {
      log('info', 'gateway.rolling_restart_done',
        { restarted: r.restarted.length, failed: r.failed.length, failedIds: r.failed.join(',') });
      return r;
    })
    .catch((err) => {
      log('error', 'gateway.rolling_restart_failed', { error: String(err) });
      return { restarted: [], failed: [] };
    })
    .finally(() => { rolling = false; });
}

// THE DASHBOARD RUNS HERE TOO. It used to be a game's alone, which meant choosing multiplayer
// in the wizard switched the container to a program with no /admin — the operator was signed
// out of the thing they had just used, and the way back was a marker file over a shell.
const maintenance = platformMaintenance({
  worlds, sharedDir, worldsDir, token: () => config.gateway.serverToken,
});
const adminRoute = gatewayAdminRoutes({
  worlds,
  sharedDir,
  config: () => config,
  accounts: frontDoor.accounts,
  sessions: adminSessions,
  version: VERSION,
  // Password-reset links and the dashboard's own absolute URLs. Same derivation as the
  // locker's, so a domain answered once in the wizard reaches every place that mints a URL.
  publicBase: () => lockerPublicBase(config.setup.domain, port, config.locker.publicBase),
  saveStorage: frontDoor.saveStorage,
  restart: (reason) => {
    log('warn', 'gateway.restart_requested', { reason });
    // The same graceful path SIGTERM takes: games drained, then the container's restart
    // policy brings this process back — through the entrypoint, which re-reads the mode.
    process.kill(process.pid, 'SIGTERM');
  },
  rollingRestart: requestRoll,
  maintenance,
});
// THE REVERSE PROXY'S CONFIG, regenerated from the current answers on every boot — the same
// thing server.ts does, and for the same reasons it gives: a data directory restored from a
// backup, or one whose file was deleted, comes back with a working proxy instead of needing
// the wizard re-run. Only the world program did it, so a MULTIPLAYER server's proxy config
// was frozen at whatever the wizard last wrote: nothing that changes it at boot — the
// launcher toggle below, a restored backup — took effect until somebody re-saved the hosting
// settings by hand. Written to the SHARED dir, which is what the caddy container mounts.
// No-ops when the content already matches.
writeCaddyfile(sharedDir, {
  domain: config.setup.domain,
  internal: config.setup.hosting === 'internal',
  port: config.setup.httpPort,
});

const directory = await startDirectory({
  worlds, host: '0.0.0.0', port,
  admin: adminRoute,
  adminAllowFrom: config.admin.allowFrom,
  maintenance: () => maintenance.get(),
  metricsToken: config.metrics.enabled ? config.metrics.token : '',
  frontDoor: frontDoor.route,
  // The operator's uploaded game files, from the SHARED dir — the same one the dashboard
  // uploads into and every world reads. Answers and mods are re-read per request, so
  // enabling a mod or switching the delivery answer reaches the next player to load the
  // page rather than the next restart.
  mwdata: mwDataRoutes({
    gameDataDir: gameDataDir(sharedDir),
    modDoc: () => presentMods(gameDataDir(sharedDir), readModDoc(sharedDir)),
    allowStockSwap: () => config.content.allowStockSwap,
    mayServe: frontDoor.mwdataGate,
  }),
  // The player app (./play mounted at /client), served here so Caddy is optional (#203).
  ...(existsSync(defaultClientDir()) ? { client: clientRoutes({
    clientDir: defaultClientDir(),
  }) } : {}),
  resolveAccount: frontDoor.resolveAccount,
  // Constant-time-ish compare on a fixed-length secret, and an empty token NEVER matches --
  // otherwise an unconfigured platform would treat every anonymous caller as trusted, which
  // is the one failure mode that must not exist.
  isTrustedServer: (auth: string) => {
    const want = config.gateway.serverToken;
    if (!want) return false;
    const got = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (got.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
    return diff === 0;
  },
  // BROWSER HARNESS ONLY. Supplied only when the operator has ALREADY opted into harness
  // auth -- the same flag, and the same reasoning, as the fixed harness password: a test
  // affordance must not be a public account-takeover path. When the flag is off this is
  // undefined, and the route it backs does not exist at all.
  ...(config.login.allowHarnessAuth
    ? {
        mintHarnessSession: (account: string, password: string) =>
          (password === HARNESS_PASSWORD && account ? frontDoor.mintSession(account) : undefined),
      }
    : {}),
});

const cap = worlds.capacity();
log('info', 'gateway.capacity', { cap: cap.cap, reason: cap.reason });
metrics.worldsRunning.addCollector(() => worlds.running);
metrics.gatewayPeersRunning.addCollector(() => worlds.peersRunning);
metrics.worldsCapacity.addCollector(() => {
  const c = worlds.capacity().cap;
  // A gauge must be a number; an unbounded cap renders as 0 ("not governed") rather than
  // Infinity, which the Prometheus text format cannot carry and metrics.ts would drop.
  return Number.isFinite(c) ? c : 0;
});

log('info', 'gateway.start', {
  port: directory.port, worldsDir, sharedDir, serverEntry, admin: '/admin',
  world: WORLD_ID,
});
// THE ONE WORLD (OT3-28) starts with the gateway and is never reaped for being empty. A
// crash restarts it on the next dial or create (crash backoff permitting).
if (!worlds.ensure(WORLD_ID)) log('error', 'gateway.world_start_failed', { id: WORLD_ID });

let shuttingDown = false;
async function shutdown(signal: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'gateway.shutdown', { signal });
  // Directory first: stop accepting new joins before tearing worlds down, so nobody is
  // handed a port that is about to disappear.
  // NOT awaited. server.close() stops listening at once, but its promise waits for every open
  // connection to end, and a spliced game socket ends only when its world closes it -- which
  // is below. Awaited, a SIGTERM with anyone playing never reached stopAll(): the gateway sat
  // here until it was KILLed, and every world (its own process group) and its sim peer lived
  // on (the harness's gateway scenarios leaked two peers each that way). It IS awaited below,
  // once the worlds have exited and closed their sockets.
  const directoryClosed = directory.close();
  unhookNotifier();
  await frontDoor.close();
  // Drain the account store's write-behind queue, which a world does on its way out and this
  // process did not. Every account MUTATION is write-through, so what was actually at stake
  // is lastSeenAt — up to one 30s timer of "when did I last see this player" — not lost
  // accounts. Cheap, and it stops the two programs differing for no reason.
  await frontDoor.accounts.flush();
  worlds.stopAll();
  // The world processes flush their stores on SIGTERM. WAIT for them: this is the container's
  // main process, and its exit ends the container with every child mid-drain — a fixed 3 s here
  // against the worlds' 20 s stop grace lost the last sweep of every world on each deploy.
  // Bounded by the supervisor's own SIGKILL escalation (docker-compose stop_grace_period is
  // sized to match).
  // Non-zero on the crash path so whatever supervises this process restarts it, rather than
  // treating a crash as a clean stop.
  await worlds.allExited();
  // Every world is gone, so every spliced socket is closed and the directory's close can
  // finish. Bounded anyway: a stuck client socket must not hold the exit until SIGKILL.
  await Promise.race([directoryClosed, new Promise((r) => setTimeout(r, 5000).unref())]);
  log('info', 'gateway.flush_complete', { signal, code });
  process.exit(code);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
// SIGUSR1 = "flush everything now" (README backup cron). The gateway itself holds only the
// account store's write-behind; the worlds hold the players and cells, so relay it. Without
// a handler Node treats SIGUSR1 as "start the inspector" and nothing was flushed.
process.on('SIGUSR1', () => {
  log('info', 'gateway.flush_signal', { worlds: worlds.running });
  void frontDoor.accounts.flush();
  worlds.signalAll('SIGUSR1');
});

// SIGHUP: the same roll, from inside the container (see requestRoll above).
process.on('SIGHUP', () => {
  if (shuttingDown) return;
  void requestRoll();
});

// THE GATEWAY HAD NO CRASH HANDLERS AT ALL. Node terminates the process on an unhandled
// rejection by default, and the gateway is the only thing that reaps worlds — so a single
// stray rejection took the gateway down, orphaned every world process, and left the ports
// held (see reapOrphanWorlds). Going through shutdown() means the worlds get their SIGTERM
// and flush their stores on the way out, instead of being abandoned mid-write.
function crashExit(kind: string, err: unknown): void {
  log('error', 'gateway.crash', { kind, error: String(err), stack: (err as Error)?.stack });
  // A CRASH ALWAYS ENDS IN AN EXIT. The orderly path closes the directory first and then waits on
  // the worlds; on 2026-10-14 that wait never returned, so the process lived on with no listener
  // and /healthz still answering -- "healthy", serving nothing, never restarted. The worlds' own
  // stop grace is 20 s; past 30 s the supervisor restarts us instead.
  setTimeout(() => process.exit(1), 30_000).unref();
  void shutdown(kind, 1);
}
process.on('uncaughtException', (err) => crashExit('uncaughtException', err));
process.on('unhandledRejection', (err) => crashExit('unhandledRejection', err));
