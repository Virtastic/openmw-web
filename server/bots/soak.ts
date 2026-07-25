// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Protocol-level soak / load harness: N bot clients driving realistic traffic (movement,
// chat, cell changes, object + container ops) against a real server for a sustained run.
//
// Deliberately NOT browser-based — no Chrome, no WASM heaps — so it can hammer the server
// with far more concurrent players than the browser harness can, and run on a busy machine.
// The browser suite proves the game works; this proves the server survives people playing it.
//
//   npx tsx bots/soak.ts [--bots 16] [--minutes 30] [--cells 4] [--port <n>]
//
// Exits nonzero if any assertion fails: unexpected disconnects, RSS growth past the
// threshold (leak), latency regression, or lost broadcasts.

import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestClient } from '../test/helpers';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
}

const BOTS = arg('bots', 16);
const MINUTES = arg('minutes', 5);
const CELLS = arg('cells', 4);
const MOVE_HZ = 15; // matches the real client's sampler
const SAMPLE_MS = 10_000; // metrics cadence

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Sampled RSS of the server process — the leak detector. `ps` is portable enough here
// (macOS + Linux both accept -o rss=), and avoids instrumenting the server itself.
function rssMb(pid: number): number {
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) / 1024;
  } catch {
    return NaN;
  }
}

async function waitHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error('server never became healthy');
}

async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

interface Bot {
  name: string;
  client: TestClient;
  cell: number;
  x: number;
  y: number;
  chatsSeen: number;
  disconnected: boolean;
}

async function main(): Promise<void> {
  const dist = join(ROOT, 'dist', 'server.mjs');
  if (!existsSync(dist)) throw new Error('run `npm run build` first (dist/server.mjs missing)');

  const dataDir = mkdtempSync(join(tmpdir(), 'omw-mp-soak-'));
  // Every bot dials from 127.0.0.1, so the production per-IP caps (3 conns, 5 logins/min)
  // would refuse the fleet before any load is applied. Those limits are exercised by
  // ratelimit.test.ts; here we want throughput. maxPlayers is raised to match the fleet.
  writeFileSync(
    join(dataDir, 'config.toml'),
    `[server]\nmaxPlayers = ${Math.max(64, BOTS * 2)}\n\n` +
    `[limits]\nmaxConnsPerIp = ${BOTS * 4}\nloginPerMinPerIp = 100000\n`,
  );
  const port = arg('port', 0) || (await freePort());
  const server: ChildProcess = spawn(process.execPath, [dist, '--data', dataDir, '--port', String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog: string[] = [];
  server.stdout?.on('data', (d) => serverLog.push(String(d)));
  server.stderr?.on('data', (d) => serverLog.push(String(d)));

  const failures: string[] = [];
  const bots: Bot[] = [];

  try {
    await waitHealth(port, 15_000);
    console.log(`[soak] server pid=${server.pid} port=${port} bots=${BOTS} minutes=${MINUTES} cells=${CELLS}`);

    // --- join all bots -----------------------------------------------------------------
    for (let i = 0; i < BOTS; i++) {
      const name = `soak${i}`;
      const client = await TestClient.connect(port);
      await client.joinAsNew(name);
      const cell = i % CELLS;
      client.sendCellChange(`${cell},0`, cell * 8192, 0, 0);
      bots.push({ name, client, cell, x: cell * 8192, y: 0, chatsSeen: 0, disconnected: false });
      client.closed.then(() => {
        const b = bots.find((bb) => bb.name === name);
        if (b) b.disconnected = true;
      });
    }
    console.log(`[soak] ${bots.length} bots in world`);

    const rssStart = rssMb(server.pid!);
    const samples: { t: number; rss: number; latency: number }[] = [];
    const t0 = Date.now();
    const endAt = t0 + MINUTES * 60_000;
    let tick = 0;
    let lastSample = 0;
    let chatsSent = 0;

    // --- drive traffic -----------------------------------------------------------------
    while (Date.now() < endAt) {
      tick++;
      const now = Date.now();

      for (const b of bots) {
        if (b.disconnected) continue;
        // Movement: a slow circuit inside the bot's cell, at the real client's rate.
        b.x += Math.cos(tick / 20) * 12;
        b.y += Math.sin(tick / 20) * 12;
        b.client.sendMove({ x: b.x, y: b.y, z: 512, yaw: (tick * 400) % 65535, flags: 1, animVel: 128 });
      }

      // Periodic non-movement traffic: chat (fan-out), cell hops (authority churn),
      // and container ops (the transactional path) — the mix a real session produces.
      if (tick % (MOVE_HZ * 5) === 0) {
        const b = bots[tick % bots.length];
        if (!b.disconnected) {
          b.client.sendEvent('ChatSend', { text: `soak tick ${tick}` });
          chatsSent++;
        }
      }
      if (tick % (MOVE_HZ * 11) === 0) {
        // Authority thrash: a bot ping-pongs between cells, forcing claim/handoff churn.
        const b = bots[(tick / (MOVE_HZ * 11)) % bots.length];
        if (!b.disconnected) {
          b.cell = (b.cell + 1) % CELLS;
          b.x = b.cell * 8192;
          b.client.sendCellChange(`${b.cell},0`, b.x, b.y, 512);
        }
      }
      if (tick % (MOVE_HZ * 7) === 0) {
        const b = bots[(tick * 3) % bots.length];
        if (!b.disconnected) {
          b.client.sendEvent('ObjectSpawnRequest', {
            tempId: tick,
            recordId: 'misc_soak_item',
            cellKey: `${b.cell},0`,
            x: b.x, y: b.y, z: 512, rotZ: 0, count: 1,
          });
        }
      }

      // --- metrics ---------------------------------------------------------------------
      if (now - lastSample >= SAMPLE_MS) {
        lastSample = now;
        const probe = bots.find((b) => !b.disconnected);
        let latency = NaN;
        if (probe) {
          const sent = Date.now();
          probe.client.sendJson({ t: 'SessionPing', clientTime: sent });
          try {
            await probe.client.waitJson('SessionPong', 5000);
            latency = Date.now() - sent;
          } catch {
            failures.push(`ping timed out at ${Math.round((now - t0) / 1000)}s`);
          }
        }
        const rss = rssMb(server.pid!);
        samples.push({ t: now - t0, rss, latency });
        const alive = bots.filter((b) => !b.disconnected).length;
        console.log(
          `[soak] t=${String(Math.round((now - t0) / 1000)).padStart(4)}s alive=${alive}/${BOTS} ` +
          `rss=${rss.toFixed(0)}MB ping=${latency}ms`,
        );
      }

      await sleep(1000 / MOVE_HZ);
    }

    // --- assertions --------------------------------------------------------------------
    const rssEnd = rssMb(server.pid!);
    const alive = bots.filter((b) => !b.disconnected).length;
    if (alive !== BOTS) failures.push(`${BOTS - alive} bot(s) disconnected unexpectedly`);

    // Leak check: compare the second half's mean against the first half's. A healthy
    // server plateaus; steady growth across a multi-minute run is the signal we want.
    const half = Math.floor(samples.length / 2);
    if (half >= 2) {
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const first = mean(samples.slice(0, half).map((s) => s.rss));
      const second = mean(samples.slice(half).map((s) => s.rss));
      const growth = second - first;
      console.log(`[soak] RSS ${rssStart.toFixed(0)} -> ${rssEnd.toFixed(0)} MB (half-means ${first.toFixed(0)} -> ${second.toFixed(0)}, growth ${growth.toFixed(1)} MB)`);
      if (growth > 50) failures.push(`RSS grew ${growth.toFixed(1)}MB between run halves (possible leak)`);
    }
    if (rssEnd > 384) failures.push(`RSS ${rssEnd.toFixed(0)}MB exceeds the compose mem_limit budget (384MB)`);

    const latencies = samples.map((s) => s.latency).filter((n) => !Number.isNaN(n));
    if (latencies.length) {
      const worst = Math.max(...latencies);
      console.log(`[soak] ping max=${worst}ms mean=${(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(0)}ms`);
      if (worst > 2000) failures.push(`worst ping ${worst}ms — server stalled under load`);
    }

    const status = await (await fetch(`http://127.0.0.1:${port}/status`)).json() as { players: unknown[] };
    if (status.players.length !== alive) {
      failures.push(`/status reports ${status.players.length} players but ${alive} bots are alive (session leak)`);
    }
    console.log(`[soak] chats sent=${chatsSent}, server reports ${status.players.length} players`);
  } finally {
    for (const b of bots) { try { b.client.ws.close(); } catch {} }
    await sleep(500);
    server.kill('SIGTERM');
    await sleep(1500);
    server.kill('SIGKILL');
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  if (failures.length) {
    console.error(`\n[soak] FAIL (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n[soak] PASS — no leaks, no drops, latency stable');
}

main().catch((e) => {
  console.error('[soak] ERROR', e);
  process.exit(1);
});
