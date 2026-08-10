// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// TWO POPULATED WORLD PROCESSES, ONE SHARED DIRECTORY, FOR AS LONG AS YOU LIKE.
//
// This is the direct check on the fault that would have emptied every world on launch day.
// SocialStore was the only store in the repo that opened its own SQLite handle instead of
// going through openDb, and therefore the only one WITHOUT `PRAGMA busy_timeout` — while being
// the one database genuinely shared by every world process. WAL admits a single writer, so N
// worlds writing presence on a 10-second heartbeat contend; with no timeout that is an instant
// SQLITE_BUSY throw rather than a short wait, and it surfaced inside setInterval, where an
// uncaughtException reaches main.ts and exits the process. Two populated worlds was all it
// took to eject everyone in one of them.
//
// A unit test proves the pragma is set. Only this proves the SYSTEM survives: real processes,
// real contention, real heartbeats, over real time.
//
//   npx tsx scripts/two-world-soak.ts [--minutes 10] [--worlds 2] [--players 2]
//
// Exits non-zero if any world dies, logs a crash, or stops answering /status.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { TestClient } from '../test/helpers';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const { values } = parseArgs({
  options: {
    minutes: { type: 'string' },
    worlds: { type: 'string' },
    players: { type: 'string' },
  },
});
const MINUTES = Number(values.minutes ?? 10);
const WORLDS = Math.max(2, Number(values.worlds ?? 2));
const PLAYERS = Math.max(1, Number(values.players ?? 2));

// The presence heartbeat is 10s (server.ts). Sampling faster than that would mostly measure
// the sampler; slower and a death could sit unnoticed for minutes.
const SAMPLE_MS = 5_000;

interface World {
  id: string;
  port: number;
  child: ChildProcess;
  out: string[];
  exited: { code: number | null; signal: string | null } | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  return false;
}

function startWorld(id: string, port: number, sharedDir: string): World {
  const dataDir = join(sharedDir, '..', `world-${id}`);
  mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, [
    '--import', 'tsx', join(ROOT, 'src', 'testhost.ts'),
    '--data', dataDir, '--shared', sharedDir, '--port', String(port),
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });

  const w: World = { id, port, child, out: [], exited: null };
  const keep = (b: Buffer): void => {
    for (const line of String(b).split('\n')) if (line.trim()) w.out.push(line);
    if (w.out.length > 400) w.out.splice(0, w.out.length - 400);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  child.on('exit', (code, signal) => { w.exited = { code, signal }; });
  return w;
}

async function main(): Promise<void> {
  // ONE shared dir for every world — that is the whole point. Per-world data dirs sit beside
  // it, exactly as the gateway lays them out.
  const base = mkdtempSync(join(tmpdir(), 'omw-soak-'));
  const sharedDir = join(base, 'shared');
  mkdirSync(sharedDir, { recursive: true });

  const basePort = 47100 + (process.pid % 200);
  const worlds: World[] = [];
  for (let i = 0; i < WORLDS; i++) {
    worlds.push(startWorld(`w${i + 1}`, basePort + i, sharedDir));
  }
  console.log(`[soak] ${WORLDS} worlds, ${PLAYERS} players each, ${MINUTES} min, shared=${sharedDir}`);

  const clients: TestClient[] = [];
  const fail = async (why: string, w?: World): Promise<never> => {
    console.error(`\n[soak] FAIL: ${why}`);
    if (w) console.error(w.out.slice(-40).join('\n'));
    for (const c of clients) { try { c.close(); } catch { /* going down anyway */ } }
    for (const x of worlds) { try { x.child.kill('SIGKILL'); } catch { /* gone */ } }
    process.exit(1);
  };

  for (const w of worlds) {
    if (!await waitHealthy(w.port, 30_000)) await fail(`world ${w.id} never became healthy`, w);
  }
  console.log('[soak] all worlds healthy');

  // POPULATED, not merely running. publishPresence only writes rows for players actually in
  // the roster, so an empty world never touches the shared database and the contention this
  // exists to reproduce never happens.
  for (const w of worlds) {
    for (let i = 0; i < PLAYERS; i++) {
      const c = await TestClient.connect(w.port);
      await c.joinAsNew(`soak-${w.id}-${i}`);
      clients.push(c);
    }
  }
  console.log(`[soak] ${clients.length} players connected; heartbeats now contend on social.sqlite`);

  const until = Date.now() + MINUTES * 60_000;
  let ticks = 0;
  while (Date.now() < until) {
    await sleep(SAMPLE_MS);
    ticks++;
    for (const w of worlds) {
      if (w.exited) {
        await fail(`world ${w.id} EXITED (code ${w.exited.code}, signal ${w.exited.signal}) — `
          + 'every player in it was ejected', w);
      }
      // A process can be alive and wedged; /status is what a player's client would see.
      try {
        const r = await fetch(`http://127.0.0.1:${w.port}/status`, { signal: AbortSignal.timeout(3000) });
        if (!r.ok) await fail(`world ${w.id} answered /status with ${r.status}`, w);
      } catch (err) {
        await fail(`world ${w.id} stopped answering /status: ${String(err)}`, w);
      }
      // The crash path logs this before exiting, so it is the earliest warning available —
      // and it catches a crash that a restart would otherwise paper over.
      const crash = w.out.find((l) => l.includes('server.crash') || l.includes('uncaughtException'));
      if (crash) await fail(`world ${w.id} logged a crash: ${crash}`, w);
    }
    // The one that was fatal before the fix. Surfaced even when it did not kill the process,
    // because presence.tick_failed means the heartbeat is being lost.
    for (const w of worlds) {
      const busy = w.out.find((l) => /SQLITE_BUSY|database is locked|presence\.tick_failed/i.test(l));
      if (busy) {
        console.warn(`[soak] WARN world ${w.id}: ${busy}`);
        w.out.length = 0; // report once per occurrence, not once per sample
      }
    }
    const mins = ((Date.now() - (until - MINUTES * 60_000)) / 60_000).toFixed(1);
    if (ticks % 6 === 0) console.log(`[soak] ${mins}/${MINUTES} min — all ${WORLDS} worlds alive`);
  }

  // The shared database must actually have been written by more than one process, or this
  // whole run proved nothing about contention.
  const files = readdirSync(sharedDir);
  if (!files.includes('social.sqlite')) {
    await fail(`social.sqlite was never created in ${sharedDir} — the worlds did not share it, `
      + `so nothing contended (saw: ${files.join(', ') || 'nothing'})`);
  }

  for (const c of clients) { try { c.close(); } catch { /* done */ } }
  for (const w of worlds) { try { w.child.kill('SIGTERM'); } catch { /* gone */ } }
  await sleep(1500);
  console.log(`\n[soak] PASS: ${WORLDS} populated worlds survived ${MINUTES} minutes on one shared dir`);
  process.exit(0);
}

void main();
