// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// CLI bootstrap: node dist/server.mjs [--data <dir>] [--port <n>]
//                 node dist/server.mjs --data <dir> --delete-account <name>  (M8 erasure)
// Data dir defaults to /data when it exists (container), else ./devdata.
// SIGTERM/SIGINT = graceful close (SessionDisconnect SHUTDOWN + flush); SIGUSR1 = flush.

import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { startServer } from './server';
import { deleteAccount } from './persist/erase';
import { log } from './log';

const { values } = parseArgs({
  options: {
    data: { type: 'string' },
    shared: { type: 'string' },
    port: { type: 'string' },
    'delete-account': { type: 'string' },
    // Where this world's clients can reach the world directory. The GATEWAY passes this when
    // it spawns a world: a spawned world has no config.toml of its own, so gateway.url stayed
    // "" and the in-game world browser was disabled — clicking Public asked for the world
    // list, got no_gateway, and silently never switched.
    gateway: { type: 'string' },
  },
});

const dataDir = values.data ?? (existsSync('/data') ? '/data' : './devdata');
const port = values.port !== undefined ? Number(values.port) : 8080;
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`invalid --port ${values.port}`);
  process.exit(2);
}

// Erasure runs OFFLINE (no listener, no live write-behind to race) and exits.
const eraseTarget = values['delete-account'];
if (eraseTarget !== undefined) {
  if (eraseTarget.length === 0) {
    console.error('usage: --delete-account <name>');
    process.exit(2);
  }
  const report = await deleteAccount(dataDir, eraseTarget);
  console.log(
    `erased "${eraseTarget}": account=${report.account} character=${report.player} banEntry=${report.bans}` +
      ` identities=${report.identities} chatLines=${report.chatLines} reports=${report.reports}`,
  );
  if (!report.account && !report.player) {
    console.error('nothing found under that name (already erased, or wrong --data dir)');
    process.exit(1);
  }
  console.log('remember to purge the account name from rotated logs (see server/PRIVACY.md)');
  process.exit(0);
}

// --shared: accounts, identities, friends and bans live here instead of in the world's own
// data dir, so several worlds share one identity. Omitted = the data dir itself, which is
// exactly the previous behaviour for anyone running a single world.
const server = await startServer({
  dataDir, port,
  ...(values.shared ? { sharedDir: values.shared } : {}),
  ...(values.gateway ? { configOverride: { gateway: { url: values.gateway } } } : {}),
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'server.signal', { signal });
  await server.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGUSR1', () => {
  log('info', 'server.flush_signal', {});
  void server.flush();
});

// Last-gasp save. Without this, an uncaught throw or a rejected promise loses up to one
// sweep interval of progress for EVERY player at once, silently.
//
// Deliberately best-effort and deliberately loud, in this order:
//   1. log the original error FIRST, so the crash is never masked by whatever the flush does
//   2. attempt the flush on a short deadline — a corrupted process may not manage it, and
//      hanging here would turn a crash into a wedge
//   3. exit NON-ZERO always, so a supervisor restarts and nobody mistakes this for a clean stop
//
// This is not a substitute for fixing the crash; it bounds the damage while you do.
function lastGaspExit(kind: string, err: unknown): void {
  log('error', 'server.crash', { kind, error: String(err), stack: (err as Error)?.stack });
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  const deadline = setTimeout(() => {
    log('error', 'server.crash_flush_timeout', {});
    process.exit(1);
  }, 5000);
  deadline.unref();
  void server.flush()
    .then(() => log('info', 'server.crash_flush_ok', {}))
    .catch((e) => log('error', 'server.crash_flush_failed', { error: String(e) }))
    .finally(() => process.exit(1));
}

process.on('uncaughtException', (err) => lastGaspExit('uncaughtException', err));
process.on('unhandledRejection', (err) => lastGaspExit('unhandledRejection', err));
