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
import { WorldSupervisor } from './worlds';
import { startDirectory } from './directory';
import { buildFrontDoor } from './frontdoor';
import { log } from '../log';

const { values } = parseArgs({
  options: {
    worlds: { type: 'string' },
    port: { type: 'string' },
    'base-port': { type: 'string' },
    'max-worlds': { type: 'string' },
    'max-per-owner': { type: 'string' },
    'public-world': { type: 'string', multiple: true },
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
const port = Number(values.port ?? 8080);
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
    // WORLDS, each of which is a Node process PLUS up to [simPeer].maxPeers sim peers at
    // ~450 MB each. 32 is a capacity number nobody has measured against a real box: at the
    // current peer cost that is tens of gigabytes if every world fills its clusters. It is set
    // where it is because one world is the shared one and the rest are per-character solo
    // worlds, so a low cap locks players out of playing alone — but treat it as a placeholder
    // and lower it to what the host actually has until the peer gets cheaper.
    maxWorlds: positiveInt(values['max-worlds'], 32, 'max-worlds'),
    idleReapMs: 120_000,
    startTimeoutMs: 120_000,
    restartBackoffMs: 15_000,
    publicWorlds: values['public-world'] ?? ['vvardenfell'],
    sharedDir,
  },
});

worlds.startPublic();
worlds.startPolling();
// The shared SSO + locker front door, on the same public port as the directory.
const frontDoor = await buildFrontDoor(sharedDir, (owner, charId) => {
  // A deleted character's solo world can never be reached again — retire it rather than
  // leaving a directory (and, until it is reaped, a process) behind for every character
  // anyone ever deletes.
  worlds.discardForCharacter(owner, charId);
});
const directory = await startDirectory({
  worlds, host: '0.0.0.0', port, worldsDir,
  maxPerOwner: Number(values['max-per-owner'] ?? 2),
  frontDoor: frontDoor.route,
  resolveAccount: frontDoor.resolveAccount,
});

log('info', 'gateway.start', {
  port: directory.port, worldsDir, sharedDir, serverEntry,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'gateway.shutdown', { signal });
  // Directory first: stop accepting new joins before tearing worlds down, so nobody is
  // handed a port that is about to disappear.
  await directory.close();
  worlds.stopAll();
  // The world processes flush their stores on SIGTERM; give them a moment to do it before
  // this process exits and the shell reaps them.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
