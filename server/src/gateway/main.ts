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
import { WorldSupervisor, reapOrphanWorlds } from './worlds';
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

const { values } = parseArgs({
  options: {
    worlds: { type: 'string' },
    port: { type: 'string' },
    'base-port': { type: 'string' },
    'max-worlds': { type: 'string' },
    'max-per-owner': { type: 'string' },
    // Testable reaping. The revive-on-dial path (a private world idles out, is reaped, and
    // comes back when its owner returns) is a real player journey with no way to exercise it
    // in scenario time while this was pinned at two minutes.
    'idle-reap-ms': { type: 'string' },
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
    // TWO CEILINGS, AND THE MEMORY ONE IS USUALLY THE REAL ONE.
    //
    // The count cap answers "how many people may play alone at once", so it tracks maxPlayers:
    // a solo world is simply where a player is when they are not in a shared one, and a cap
    // below maxPlayers means a server advertising N seats cannot seat N people playing alone.
    //
    // What used to be written here was that this is NOT the memory governor, because "sim
    // peers are capped SEPARATELY by [simPeer].maxPeers and are spawned on demand, not pinned
    // one-per-world, so worlds do not multiply the peer's cost". THAT IS FALSE, and it is the
    // reasoning that left this box undefended: every world is its own PROCESS and each one
    // runs its own SimPeerSupervisor (gateway/worlds.ts), so [simPeer].maxPeers is per world.
    // Worlds multiply the peer's cost exactly. With maxPlayers at 256 the supervisor would
    // spawn worlds until the OOM killer took the container, while every per-world cap read as
    // satisfied and simpeer.at_cap never fired.
    //
    // So the memory budget is passed too, and capacity() takes the lower of the two. Size a
    // host by measuring on it and setting [worlds] memBudgetMb/worldCostMb/peerCostMb — not
    // from a number in a comment, this one included.
    //
    // peerCostMb is there because the sentence above was itself overtaken: a world no longer
    // costs "one world+peer" at all. Peers are one per OCCUPIED CELL, so a world's price is
    // worldCostMb plus peerCostMb for every peer past the first, and the ceiling moves as
    // players spread out. Measuring one world with one peer and stopping there is how this
    // box would get undefended a second time, by the same reasoning in a different shape.
    maxWorlds: positiveInt(values['max-worlds'],
      config.worlds.maxWorlds > 0 ? config.worlds.maxWorlds : config.server.maxPlayers,
      'max-worlds'),
    memBudgetMb: config.worlds.memBudgetMb,
    worldCostMb: config.worlds.worldCostMb,
    peerCostMb: config.worlds.peerCostMb,
    gatewayReserveMb: config.worlds.gatewayReserveMb,
    idleReapMs: positiveInt(values['idle-reap-ms'], 120_000, 'idle-reap-ms'),
    startTimeoutMs: 120_000,
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
const frontDoor = await buildFrontDoor(sharedDir, (owner, charId) => {
  // A deleted character's solo world can never be reached again — retire it rather than
  // leaving a directory (and, until it is reaped, a process) behind for every character
  // anyone ever deletes.
  return worlds.discardForCharacter(owner, charId).then(() => undefined);
}, port, adminSessions);

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
  publicBase: () => config.locker.publicBase || `http://127.0.0.1:${port}`,
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
const directory = await startDirectory({
  worlds, host: '0.0.0.0', port, worldsDir,
  admin: adminRoute,
  maintenance: () => maintenance.get(),
  // One private world per player the server can hold. These are the SAME quantity seen from
  // two directions — a solo world is where a player is when they are not in a shared one — so
  // a cap below maxPlayers means a server advertising N seats cannot actually seat N people.
  // It was a standalone default of 2, which locked an account out after two characters and
  // read as an unexplained 429 mid-sign-in. --max-per-owner still overrides for a small host.
  maxPerOwner: Number(values['max-per-owner'] ?? config.server.maxPlayers),
  metricsToken: config.metrics.enabled ? config.metrics.token : '',
  frontDoor: frontDoor.route,
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
  privateWorldIdFor: frontDoor.privateWorldIdFor,
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

// SAY THE CEILING OUT LOUD, AT BOOT. A platform that refuses a world at 03:00 must not be the
// first time anyone learns what its limit was, and "no memory governor configured" is a
// condition an operator should be told about rather than discover from an OOM kill.
//
// This is the BEST CASE and is logged as such. The memory ceiling is computed from what the
// running worlds have committed, and a world costs one sim peer per OCCUPIED CELL — so the real
// ceiling falls as players spread out. The live number is the worlds_capacity gauge, which
// re-reads capacity() on every scrape; this line is the ceiling on an empty box.
const cap = worlds.capacity();
log('info', 'gateway.capacity', {
  capIfEmpty: cap.cap,
  reason: cap.reason,
  memBudgetMb: config.worlds.memBudgetMb,
  worldCostMb: config.worlds.worldCostMb,
  peerCostMb: config.worlds.peerCostMb,
  ...(config.worlds.memBudgetMb <= 0
    ? { warning: 'no [worlds] memBudgetMb set: only the count cap applies, and worlds carry a sim peer each' }
    : {}),
});
metrics.worldsRunning.addCollector(() => worlds.running);
metrics.gatewayPeersRunning.addCollector(() => worlds.peersRunning);
metrics.gatewayCommittedMb.addCollector(() => worlds.committed);
metrics.worldsCapacity.addCollector(() => {
  const c = worlds.capacity().cap;
  // A gauge must be a number; an unbounded cap renders as 0 ("not governed") rather than
  // Infinity, which the Prometheus text format cannot carry and metrics.ts would drop.
  return Number.isFinite(c) ? c : 0;
});

log('info', 'gateway.start', {
  port: directory.port, worldsDir, sharedDir, serverEntry, admin: '/admin',
  // NO WORLD RUNS AT BOOT: there is no public world, so nothing spawns a sim peer until a
  // player creates their own — a deploy check must not read that silence as "the peer is
  // broken".
});

let shuttingDown = false;
async function shutdown(signal: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'gateway.shutdown', { signal });
  // Directory first: stop accepting new joins before tearing worlds down, so nobody is
  // handed a port that is about to disappear.
  await directory.close();
  unhookNotifier();
  await frontDoor.close(); // drain the CRM queue; a redeploy is when signups cluster
  worlds.stopAll();
  // The world processes flush their stores on SIGTERM; give them a moment to do it before
  // this process exits and the shell reaps them.
  // Non-zero on the crash path so whatever supervises this process restarts it, rather than
  // treating a crash as a clean stop.
  setTimeout(() => process.exit(code), 3000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

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
  void shutdown(kind, 1);
}
process.on('uncaughtException', (err) => crashExit('uncaughtException', err));
process.on('unhandledRejection', (err) => crashExit('unhandledRejection', err));
