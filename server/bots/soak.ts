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
// Phase D scaling modes (see server/README.md "Measured capacity"):
//   --onecell            every bot claims the SAME cellKey, so all are mutually visible
//                        and ONE of them holds actor authority for the cell. This is the
//                        hard case the spread-across-cells soak never exercises: pose
//                        fan-out is O(N) per client / O(N^2) aggregate, and every
//                        non-holder renders the cell's actors off one client's wire.
//   --ramp               hold 8 -> 16 -> 24 -> 32 bots in one cell (implies --onecell),
//                        reporting a full measurement row per step.
//   --steps 8,16,32      override the ramp ladder.
//   --step-minutes 3     hold time per ramp step.
//
// Exits nonzero if any assertion fails: unexpected disconnects, RSS growth past the
// threshold (leak), latency regression, lost broadcasts, or actor-state divergence.

import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestClient } from '../test/helpers';
import { MSG_PLAYER_MOVE_BATCH, MSG_ACTOR_MOVE_BATCH } from '../src/proto/envelope';
import { unpackActorMoveBatch, unpackMoveBatch, type ActorEntry } from '../src/proto/movement';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// Validated: a typo'd value used to sail through as NaN and silently produce a zero-length
// run that still printed PASS.
function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const raw = process.argv[i + 1];
  const n = Number(raw);
  if (raw === undefined || !Number.isFinite(n) || n < 0) throw new Error(`--${name} needs a non-negative number, got ${String(raw)}`);
  return n;
}

function listArg(name: string, dflt: number[]): number[] {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const raw = process.argv[i + 1];
  if (!raw) throw new Error(`--${name} needs a comma-separated list`);
  const xs = raw.split(',').map((s) => Number(s.trim()));
  if (xs.some((n) => !Number.isInteger(n) || n < 1)) throw new Error(`--${name} must be positive integers, got "${raw}"`);
  for (let k = 1; k < xs.length; k++) if (xs[k]! <= xs[k - 1]!) throw new Error(`--${name} must be strictly increasing (the ramp only grows)`);
  return xs;
}

const RAMP = flag('ramp');
const ONECELL = flag('onecell') || RAMP; // a ramp is only meaningful inside one cell

// --layout decides whether interest management can help at all, and the two answers are
// very different products:
//   cluster (default) — every bot inside lodNearRadius of every other. A town square, a
//     market, a boss fight. The radius NEVER bites, everyone stays near-tier at 15 Hz, and
//     only the serialization/allocation wins apply. There is a nearest-K FLOOR but no
//     ceiling, so a real crowd defeats culling entirely. This is the number that decides
//     whether a headline player count is publishable.
//   spread — bots on a grid spanning several interest radii, so culling, the LOD tiers and
//     PlayerLeaveView all engage. This is the optimistic case.
const LAYOUT = (() => {
  const i = process.argv.indexOf('--layout');
  if (i === -1) return 'cluster';
  const v = process.argv[i + 1];
  if (v !== 'cluster' && v !== 'spread') throw new Error(`--layout must be cluster|spread, got ${String(v)}`);
  return v;
})();
const CLUSTER_RADIUS = 1800; // max pairwise 3600 < lodNearRadius 4096
const SPREAD_PITCH = 6000; // neighbours mid-tier, diagonals far-tier, corners culled

// Deterministic so a rerun places the same fleet. Cluster = golden-angle disc (even fill,
// no lattice artefacts); spread = square grid.
function layoutPos(i: number, n: number): { x: number; y: number } {
  if (LAYOUT === 'cluster') {
    const r = CLUSTER_RADIUS * Math.sqrt(n <= 1 ? 0 : i / (n - 1));
    const th = i * 2.399963229728653;
    return { x: r * Math.cos(th), y: r * Math.sin(th) };
  }
  const side = Math.ceil(Math.sqrt(n));
  return { x: (i % side) * SPREAD_PITCH, y: Math.floor(i / side) * SPREAD_PITCH };
}
const STEPS = RAMP ? listArg('steps', [8, 16, 24, 32]) : [arg('bots', 16)];
const STEP_MINUTES = RAMP ? arg('step-minutes', 3) : arg('minutes', 5);
const MAX_BOTS = STEPS[STEPS.length - 1]!;
const CELLS = ONECELL ? 1 : arg('cells', 4);
// --cellkey lets --attach share a cell with real browser clients, whose cell is retail
// content ("-2,-9"), not the synthetic "0,0" the standalone ramp uses.
const ONE_CELL_KEY = (() => {
  const i = process.argv.indexOf('--cellkey');
  if (i === -1) return '0,0';
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error('--cellkey needs a cell key, e.g. --cellkey -2,-9');
  return v;
})();
// Bots must stand where they SAY they stand. The layout is anchored at the claimed cell's
// centre, not at the world origin: with --cellkey -2,-9 (Seyda Neen) a bot posed at (0,0)
// is ~75k units from anyone actually in that cell, so interest culling correctly removes it
// and the crowd never reaches the client at all — a load test that applies no load, and a
// frame-rate measurement of an empty scene. Exterior cells are 8192 units square.
const CELL_SIZE = 8192;
const CELL_ORIGIN = (() => {
  const m = /^(-?\d+),(-?\d+)$/.exec(ONE_CELL_KEY);
  if (!m) return { x: 0, y: 0 }; // interior key: no world grid to anchor to
  return { x: (parseInt(m[1]!, 10) + 0.5) * CELL_SIZE, y: (parseInt(m[2]!, 10) + 0.5) * CELL_SIZE };
})();
// Bot names are account keys. Two soak processes attached to the SAME server both naming
// their bots soak0..soakN collide: the second registration supersedes the first session
// rather than adding a player, so the population silently stops growing. --prefix keeps
// concurrent waves distinct (see s43, which ramps by attaching successive waves).
const NAME_PREFIX = (() => {
  const i = process.argv.indexOf('--prefix');
  if (i === -1) return 'soak';
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error('--prefix needs a value, e.g. --prefix wave2_');
  return v;
})();
const MOVE_HZ = 15; // matches the real client's sampler
const SAMPLE_MS = 10_000; // metrics cadence
const SETTLE_MS = 15_000; // discarded head of each step: joins are not steady state

// One measurement row per ramp step. Bandwidth is per-CLIENT inbound, because that is the
// number that breaks first: every occupant's pose fans out to every other occupant.
interface StepRow {
  n: number;
  alive: number;
  rssMb: number;
  cpuPct: number;
  botCpuPct: number; // harness self-load; a capacity claim is void if this is pegged
  // Post-D-fix shed counters: where a crowded cell used to DISCONNECT the authority holder
  // it now drops stale-tolerant frames instead, so these must be read to know it happened.
  layout: string;
  visPeersMean: number; // peers actually relayed to each client — culling's read-out
  visPeersMax: number;
  leaveViews: number;
  moveShed: number;
  actorShed: number;
  bpDropped: number;
  bufferedKb: number;
  rxKbMean: number;
  rxKbMax: number;
  aggKbSec: number;
  playerBatchHz: number;
  playerEntryHz: number; // poses per second per client — the O(N) term
  actorBatchHz: number;
  actorSentHz: number;
  actorDropPct: number | null;
  growJoinMs: number;
  probeWelcomeMs: number;
  probeFirstBatchMs: number;
  pingMean: number;
  pingMax: number;
  // null = there was no actor stream to measure (spread mode), NOT zero divergence.
  divergent: number | null;
  worstLag: number | null;
}

// Synthetic actor load for the correctness invariant. 16 actors at the client's own move
// rate is a plausibly-populated retail cell; the holder alone pays the send cost and every
// other occupant pays the receive cost, which is exactly the TES3MP per-cell-authority
// shape we are trying to falsify.
const ACTOR_COUNT = 16;
// > the widest LOD stride (far tier = every 15th tick), so every peer gets at least one.
const ACTOR_FLUSH_FRAMES = 20;
const ACTOR_REFS = Array.from({ length: ACTOR_COUNT }, (_, i) => ({ index: 1000 + i, contentFile: 0 }));
const refKey = (r: { index: number; contentFile: number }) => `${r.contentFile}:${r.index}`;

const METRICS_TOKEN = 'soak-scrape';
const CPUPROF = (() => {
  const i = process.argv.indexOf('--cpuprof');
  if (i === -1) return '';
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error('--cpuprof needs an output directory');
  return v;
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Scrapes the counters a crowded cell is expected to move. Returns 0 for a series the
// server has never incremented (Prometheus omits untouched label sets), which is the
// honest reading — but a scrape that FAILS must never be silently reported as zero.
async function scrapeMetrics(port: number): Promise<Record<string, number>> {
  const res = await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { Authorization: `Bearer ${METRICS_TOKEN}` } });
  if (!res.ok) throw new Error(`/metrics scrape failed: ${res.status} ${res.statusText}`);
  const out: Record<string, number> = {
    move_shed: 0, actor_shed: 0, bp_move: 0, bp_actor: 0, buffered: 0, rate_msgs: 0, rate_bytes: 0,
  };
  for (const line of (await res.text()).split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    const sp = line.lastIndexOf(' ');
    const key = line.slice(0, sp);
    const val = Number(line.slice(sp + 1));
    if (!Number.isFinite(val)) continue;
    if (key === 'omwmp_rate_limited_total{budget="move_shed"}') out['move_shed'] = val;
    else if (key === 'omwmp_rate_limited_total{budget="actor_shed"}') out['actor_shed'] = val;
    else if (key === 'omwmp_rate_limited_total{budget="msgs"}') out['rate_msgs'] = val;
    else if (key === 'omwmp_rate_limited_total{budget="bytes"}') out['rate_bytes'] = val;
    else if (key === 'omwmp_backpressure_dropped_total{kind="move"}') out['bp_move'] = val;
    else if (key === 'omwmp_backpressure_dropped_total{kind="actor"}') out['bp_actor'] = val;
    else if (key === 'omwmp_outbound_buffered_bytes') out['buffered'] = val;
  }
  return out;
}

// Sampled RSS + CPU-seconds of the server process. `ps` is portable enough here (macOS +
// Linux both accept these) and avoids instrumenting the server itself. CPU is taken as
// accumulated cpu TIME, not ps's %cpu: %cpu is a decaying average over an unspecified
// window, so per-step attribution needs a delta over a known interval.
function procStat(pid: number | undefined): { rssMb: number; cpuSec: number } {
  if (pid === undefined) return { rssMb: NaN, cpuSec: NaN };
  try {
    const out = execFileSync('ps', ['-o', 'rss=,time=', '-p', String(pid)]).toString().trim();
    const [rss, time] = out.split(/\s+/);
    const parts = (time ?? '').split(/[:]/).map(Number).reverse(); // ss(.ff), mm, hh
    const cpuSec = (parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600;
    return { rssMb: Number(rss) / 1024, cpuSec };
  } catch {
    return { rssMb: NaN, cpuSec: NaN };
  }
}

function rssMb(pid: number | undefined): number {
  return procStat(pid).rssMb;
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
  playerId: number;
  cell: number;
  cellKey: string;
  x: number;
  y: number;
  chatsSeen: number;
  disconnected: boolean;
  // --- wire instrumentation (own ws listener; independent of TestClient's inbox) --------
  rxBytes: number;
  rxFrames: number;
  rxPlayerBatches: number;
  rxPlayerEntries: number;
  rxActorBatches: number;
  // Actor state as this bot would render it: refKey -> last pose seen. The holder encodes a
  // monotonic broadcast sequence in pose.x, so `seqsSeen` measures LOSS and `actors`
  // measures AGREEMENT after quiescence.
  baseX: number;
  baseY: number;
  // Distinct peers whose poses actually reached this bot in the window — the direct
  // read-out of interest management (cluster: everyone; spread: the culled subset).
  sendersSeen: Set<number>;
  actors: Map<string, { x: number; y: number; z: number }>;
  seqsSeen: Set<number>;
  badEpoch: number;
}

// Counts every inbound frame at the socket, before TestClient decodes it. Bytes are
// application payload only — the ws frame header adds ~2-6 B on top of each, which is why
// frame counts are reported alongside.
function instrument(b: Bot): void {
  b.client.ws.on('message', (data: Buffer, isBinary: boolean) => {
    b.rxBytes += data.length;
    b.rxFrames++;
    if (!isBinary || data.length < 6) return;
    const type = data.readUInt16LE(0);
    const payload = data.subarray(6);
    if (type === MSG_PLAYER_MOVE_BATCH) {
      b.rxPlayerBatches++;
      try {
        const entries = unpackMoveBatch(payload);
        b.rxPlayerEntries += entries.length;
        for (const e of entries) b.sendersSeen.add(e.id);
      } catch (err) {
        throw new Error(`[${b.name}] undecodable PlayerMoveBatch: ${String(err)}`);
      }
    } else if (type === MSG_ACTOR_MOVE_BATCH) {
      b.rxActorBatches++;
      let batch;
      try {
        batch = unpackActorMoveBatch(payload);
      } catch (err) {
        throw new Error(`[${b.name}] undecodable ActorMoveBatch: ${String(err)}`);
      }
      for (const e of batch.entries) {
        b.actors.set(refKey(e.ref), { x: e.pose.x, y: e.pose.y, z: e.pose.z });
        b.seqsSeen.add(e.pose.x); // x carries the holder's broadcast sequence
      }
    }
  });
}

// TestClient retains every decoded frame forever. At 32 bots in one cell that is tens of
// thousands of batches per minute per bot, and the BOT process OOMs long before the server
// does — which would read as a server capacity limit. The move batches are consumed by the
// listener above, so drop the retained copies; the end-of-run invariants only use `events`.
function trimInboxes(bots: Bot[]): void {
  for (const b of bots) {
    b.client.inbox.batches.length = 0;
    b.client.inbox.actorBatches.length = 0;
  }
}

async function main(): Promise<void> {
  // testhost.mjs, NOT server.mjs: main.ts refuses to boot without game data, a peer binary
  // and a server password, so spawning it here failed at "server never became healthy" from
  // the moment that mandate landed. src/testhost.ts is the same server via the code-only
  // requireGameData seam. NOTE it has no sim peer, so an attached run measures the SERVER
  // under player load — actor authority needs a scenario that stands a peer up itself.
  const dist = join(ROOT, 'dist', 'testhost.mjs');
  if (!existsSync(dist)) throw new Error('run `npm run build` first (dist/testhost.mjs missing)');

  // --attach <port>: drive an ALREADY-RUNNING server instead of spawning one, so the
  // browser scenario harness can put bot load on the same server its real clients are on.
  // The attached server's memory belongs to someone else, so RSS/CPU rows read NaN and the
  // leak/RSS gates below are skipped — this mode measures the CLIENTS, not the host.
  const ATTACH = arg('attach', 0);
  let dataDir = '';
  let server: ChildProcess | null = null;
  let port = ATTACH;
  if (!ATTACH) {
    dataDir = mkdtempSync(join(tmpdir(), 'omw-mp-soak-'));
    // Every bot dials from 127.0.0.1, so the production per-IP caps (3 conns, 5 logins/min)
    // would refuse the fleet before any load is applied. Those limits are exercised by
    // ratelimit.test.ts; here we want throughput. maxPlayers is raised to match the fleet.
    writeFileSync(
      join(dataDir, 'config.toml'),
      `[server]\nmaxPlayers = ${Math.max(64, MAX_BOTS * 2)}\n\n` +
      `[limits]\nmaxConnsPerIp = ${MAX_BOTS * 4 + 8}\nloginPerMinPerIp = 100000\n\n` +
      // Shed and backpressure are the whole point of a crowded-cell ramp: without the
      // scrape the run cannot tell "nothing was dropped" from "drops were invisible".
      `[metrics]\nenabled = true\ntoken = "${METRICS_TOKEN}"\n`,
    );
    port = arg('port', 0) || (await freePort());
    // --cpuprof <dir>: run the server under V8's sampling profiler so a step's CPU can be
    // ATTRIBUTED (per-peer ws.send vs roster.inWorld vs codec) instead of just totalled.
    // The profile is only written on a clean exit, so teardown waits for SIGTERM below.
    const profArgs = CPUPROF ? ['--cpu-prof', '--cpu-prof-dir', CPUPROF] : [];
    server = spawn(process.execPath, [...profArgs, dist, '--data', dataDir, '--port', String(port)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const serverLog: string[] = [];
    server.stdout?.on('data', (d) => serverLog.push(String(d)));
    server.stderr?.on('data', (d) => serverLog.push(String(d)));
  }
  const serverPid = server?.pid;

  const failures: string[] = [];
  const bots: Bot[] = [];

  try {
    await waitHealth(port, 15_000);
    console.log(
      `[soak] server pid=${serverPid ?? 'attached'} port=${port} steps=${STEPS.join('->')} stepMinutes=${STEP_MINUTES} ` +
      `cells=${ONECELL ? `1 (${ONE_CELL_KEY})` : CELLS}${RAMP ? ' [ramp]' : ''}`,
    );

    const samples: { t: number; rss: number; latency: number }[] = [];
    const rows: StepRow[] = [];
    const t0 = Date.now();
    let tick = 0;
    let chatsSent = 0;
    let journalStage = 0;
    let recordsRequested = 0;
    let actorSeq = 0;
    let actorPaused = true; // the holder only broadcasts inside a measured window
    let holderEpoch: number | undefined;
    let rssStart = NaN;
    const authVerified = new Set<string>(); // non-holders whose ActorAuthorityInfo has landed

    // --- fleet ---------------------------------------------------------------------------
    const joinBot = async (i: number): Promise<number> => {
      const name = `${NAME_PREFIX}${i}`;
      const t = Date.now();
      const client = await TestClient.connect(port);
      // Honest capability. In standalone/--onecell the fleet DOES simulate — bot 0 holds the
      // cell and streams synthesised actor poses — so it claims the capability. Under
      // --attach it does not: a real browser client is the holder, and the bots are pure
      // fan-out load that never send an ActorMoveBatch. Claiming it there would let a bot
      // win the fitness election and freeze every NPC in the cell for the real players,
      // which is exactly the failure s42 was reporting.
      client.simulatesActors = !ATTACH;
      const { playerId } = await client.joinAsNew(name);
      const welcomeMs = Date.now() - t;
      const cell = ONECELL ? 0 : i % CELLS;
      const cellKey = ONECELL ? ONE_CELL_KEY : `${cell},0`;
      // Laid out against the FINAL fleet size so positions never shift as the ramp grows —
      // a moving layout would change every pairwise distance mid-run and make the LOD tier
      // mix incomparable between steps.
      const layout = layoutPos(i, MAX_BOTS);
      const base = ONECELL
        ? { x: CELL_ORIGIN.x + layout.x, y: CELL_ORIGIN.y + layout.y }
        : { x: cell * CELL_SIZE, y: 0 };
      client.sendCellChange(cellKey, base.x, base.y, 0);
      const bot: Bot = {
        name, client, playerId, cell, cellKey, x: base.x, y: base.y, baseX: base.x, baseY: base.y,
        chatsSeen: 0, disconnected: false,
        rxBytes: 0, rxFrames: 0, rxPlayerBatches: 0, rxPlayerEntries: 0, rxActorBatches: 0,
        sendersSeen: new Set(), actors: new Map(), seqsSeen: new Set(), badEpoch: 0,
      };
      instrument(bot);
      bots.push(bot);
      client.closed.then(() => { bot.disconnected = true; });
      return welcomeMs;
    };

    // Join cost with N already in the cell, split into its two very different halves:
    // `welcome` is dominated by argon2id registration (CPU, not fan-out), `firstBatch` is
    // the server actually wiring the newcomer into the running broadcast — that second
    // number is the one that should degrade with crowding. Briefly makes the cell N+1.
    const joinProbe = async (n: number): Promise<{ welcomeMs: number; firstBatchMs: number }> => {
      const t = Date.now();
      const client = await TestClient.connect(port);
      await client.joinAsNew(`probe${n}x${Date.now()}`);
      const welcomeMs = Date.now() - t;
      // Anchored like the fleet: a probe posed at the world origin inside a retail cell is
      // culled by distance, so it would wait out the full timeout for a first batch that
      // was never going to arrive and report the join as slow rather than as mislocated.
      client.sendCellChange(ONECELL ? ONE_CELL_KEY : '0,0',
        ONECELL ? CELL_ORIGIN.x : 0, ONECELL ? CELL_ORIGIN.y : 0, 0);
      let firstBatchMs = NaN;
      try {
        await client.waitBatch(() => true, 15_000);
        firstBatchMs = Date.now() - t;
      } catch (err) {
        failures.push(`join probe at N=${n} never received a PlayerMoveBatch: ${String(err)}`);
      }
      client.ws.close();
      return { welcomeMs, firstBatchMs };
    };

    // --- traffic driver ------------------------------------------------------------------
    const drive = async (ms: number, pings: number[]): Promise<void> => {
      const stop = Date.now() + ms;
      let lastSample = 0;
      while (Date.now() < stop) {
        tick++;
        const now = Date.now();

        for (const b of bots) {
          if (!b || b.disconnected) continue;
          // Movement: a slow circuit inside the bot's cell, at the real client's rate.
          b.x += Math.cos(tick / 20) * 12;
          b.y += Math.sin(tick / 20) * 12;
          b.client.sendMove({ x: b.x, y: b.y, z: 512, yaw: (tick * 400) % 65535, flags: 1, animVel: 128 });
        }

        // The cell's actor-authority holder simulating its NPCs. bots[0] claimed the cell
        // first, so it is the holder; the sequence number rides in pose.x so receivers can
        // be checked for LOSS and for AGREEMENT, not merely for "some traffic arrived".
        if (ONECELL && !actorPaused && holderEpoch !== undefined) {
          const holder = bots[0];
          if (holder && !holder.disconnected) {
            actorSeq++;
            const entries: ActorEntry[] = ACTOR_REFS.map((ref, i) => ({
              ref,
              pose: { x: actorSeq, y: i * 100, z: 512, yaw: 0, pitch: 128, flags: 0, animVel: 0, counter: 0 },
            }));
            holder.client.sendActorMoveBatch(holderEpoch, entries);
          }
        }

        // Periodic non-movement traffic: chat (fan-out), cell hops (authority churn),
        // and container ops (the transactional path) — the mix a real session produces.
        if (tick % (MOVE_HZ * 5) === 0) {
          const b = bots[tick % bots.length];
          if (b && !b.disconnected) {
            b.client.sendEvent('ChatSend', { text: `soak tick ${tick}` });
            chatsSent++;
          }
        }
        // Cell hops are suppressed in --onecell: the point of the mode is that nobody
        // leaves, and a hop would hand authority off mid-measurement.
        if (!ONECELL && tick % (MOVE_HZ * 11) === 0) {
          // Authority thrash: a bot ping-pongs between cells, forcing claim/handoff churn.
          const b = bots[(tick / (MOVE_HZ * 11)) % bots.length];
          if (b && !b.disconnected) {
            b.cell = (b.cell + 1) % CELLS;
            b.cellKey = `${b.cell},0`;
            b.x = b.cell * 8192;
            b.client.sendCellChange(b.cellKey, b.x, b.y, 512);
          }
        }
        if (tick % (MOVE_HZ * 7) === 0) {
          const b = bots[(tick * 3) % bots.length];
          if (b && !b.disconnected) {
            b.client.sendEvent('ObjectSpawnRequest', {
              tempId: tick,
              recordId: 'misc_soak_item',
              cellKey: b.cellKey,
              x: b.x, y: b.y, z: 512, rotZ: 0, count: 1,
            });
          }
        }

        // M5-M7 families. Stability under load is not enough for these: they carry
        // ARBITRATED state (journal is monotonic-max, records get server-issued ids), so the
        // soak also checks those invariants hold while everything else is thrashing.
        if (tick % (MOVE_HZ * 9) === 0) {
          // Combat: hit a random OTHER player. With [rules] pvp default false these are
          // dropped by the pvp plugin — which is itself worth hammering (the drop path runs
          // on every hit), and the victim must never take damage state from it.
          const atk = bots[tick % bots.length];
          const vic = bots[(tick + 3) % bots.length];
          if (atk && vic && !atk.disconnected && !vic.disconnected && atk !== vic && atk.cell === vic.cell) {
            atk.client.sendEvent('CombatHit', {
              target: { playerId: vic.playerId },
              damage: { health: 5 }, strength: 1, sourceType: 'melee', successful: true,
            });
          }
        }
        if (tick % (MOVE_HZ * 13) === 0) {
          // Journal: every bot pushes the SAME quest, racing the monotonic-max arbitration.
          journalStage++;
          const b = bots[(tick * 7) % bots.length];
          if (b && !b.disconnected) {
            b.client.sendEvent('JournalEntry', { questId: 'soak_quest', index: journalStage });
            // Also push a deliberately STALE index: it must never move the shared stage back.
            b.client.sendEvent('JournalEntry', { questId: 'soak_quest', index: 1 });
          }
        }
        if (tick % (MOVE_HZ * 17) === 0) {
          const b = bots[(tick * 11) % bots.length];
          if (b && !b.disconnected) {
            recordsRequested++;
            b.client.sendEvent('RecordCreate', {
              tempId: recordsRequested,
              kind: 'potion',
              data: { name: `soak potion ${recordsRequested}`, weight: 0.5 },
            });
          }
        }
        if (tick % (MOVE_HZ * 23) === 0) {
          // Resting advances the clock for EVERYONE — contended by design here.
          const b = bots[(tick * 5) % bots.length];
          if (b && !b.disconnected) b.client.sendEvent('WorldTimeRequest', { advanceHours: 1, reason: 'rest' });
        }

        // --- metrics -------------------------------------------------------------------
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
              pings.push(latency);
            } catch {
              failures.push(`ping timed out at ${Math.round((now - t0) / 1000)}s with ${bots.length} bots`);
            }
          }
          const rss = rssMb(serverPid);
          samples.push({ t: now - t0, rss, latency });
          const alive = bots.filter((b) => !b.disconnected).length;
          console.log(
            `[soak] t=${String(Math.round((now - t0) / 1000)).padStart(4)}s alive=${alive}/${bots.length} ` +
            `rss=${rss.toFixed(0)}MB ping=${latency}ms`,
          );
          trimInboxes(bots);
        }

        await sleep(1000 / MOVE_HZ);
      }
    };

    // --- ramp ----------------------------------------------------------------------------
    for (const target of STEPS) {
      const growJoins: number[] = [];
      while (bots.length < target) growJoins.push(await joinBot(bots.length));
      if (Number.isNaN(rssStart)) rssStart = rssMb(serverPid);

      // Authority: bots[0] entered the cell first, so it holds it. READ the epoch off the
      // grant rather than assuming one — a wrong epoch makes every ActorMoveBatch a silent
      // server-side drop, which would masquerade as 100% packet loss.
      // In --attach the cell is already held by whoever got there first (a real browser
      // client in s42), so the bots are pure load and pure receivers: no synthetic actor
      // stream, no holder-side assertions. Standalone, bots[0] entered first and MUST hold.
      if (ONECELL && !ATTACH && holderEpoch === undefined) {
        const grant = await bots[0]!.client.waitEvent('ActorAuthorityGrant', () => true, 15_000);
        holderEpoch = Number((grant.value as { epoch?: number }).epoch);
        if (!Number.isInteger(holderEpoch)) throw new Error(`ActorAuthorityGrant carried no usable epoch: ${JSON.stringify(grant.value)}`);
        console.log(`[soak] holder=${bots[0]!.name} pid=${bots[0]!.playerId} cell=${ONE_CELL_KEY} epoch=${holderEpoch}`);
      }
      if (ONECELL && !ATTACH) {
        // Every non-holder must be TOLD who the holder is. Without this the divergence
        // check below could pass on a cell nobody was ever wired into. Awaited, not
        // sampled: the Info chases the bot's PlayerCellChange through the op queue and is
        // routinely a few hundred ms behind the join.
        for (const b of bots.slice(1)) {
          if (authVerified.has(b.name)) continue;
          const info = await b.client.waitEvent('ActorAuthorityInfo', () => true, 15_000)
            .catch((e: unknown) => { failures.push(`${b.name} never received ActorAuthorityInfo for ${ONE_CELL_KEY}: ${String(e)}`); return undefined; });
          if (!info) continue;
          const holderId = (info.value as { holderId?: number }).holderId;
          if (holderId !== bots[0]!.playerId) failures.push(`${b.name} thinks holder is ${holderId}, expected ${bots[0]!.playerId}`);
          authVerified.add(b.name);
        }
        if (bots[0]!.client.inbox.events.some((e) => e.name === 'ActorAuthorityRevoke')) {
          failures.push('holder was revoked mid-ramp — the step measurements below are not attributable');
        }
      }

      // Settle first: the join burst (argon2 + force-include batches) is not steady state.
      actorPaused = false;
      const stepPings: number[] = [];
      await drive(SETTLE_MS, stepPings);

      // --- measurement window ---
      const winT0 = Date.now();
      const cpu0 = procStat(serverPid);
      // The harness runs 32 clients in ONE event loop. If it saturates, its own backpressure
      // shows up as server latency — so its CPU is reported alongside, and any capacity
      // number taken while this is pegged is the HARNESS's limit, not the server's.
      const botCpu0 = procStat(process.pid);
      const m0 = ATTACH ? null : await scrapeMetrics(port);
      const base = bots.map((b) => ({ rxBytes: b.rxBytes, rxFrames: b.rxFrames, pb: b.rxPlayerBatches, pe: b.rxPlayerEntries, ab: b.rxActorBatches }));
      for (const b of bots) { b.seqsSeen.clear(); b.sendersSeen.clear(); }
      const leaveView0 = bots.map((b) => b.client.inbox.events.filter((e) => e.name === 'PlayerLeaveView').length);
      const seqStart = actorSeq;
      const holdMs = Math.max(0, STEP_MINUTES * 60_000 - SETTLE_MS);

      // Join probe ~60% into the window, so N bots are fully in steady state around it.
      let probeResult: { welcomeMs: number; firstBatchMs: number } = { welcomeMs: NaN, firstBatchMs: NaN };
      const probeTimer = setTimeout(() => {
        void joinProbe(target)
          .then((r) => { probeResult = r; })
          // A probe that cannot even connect IS the finding at this N — record it, never drop it.
          .catch((e: unknown) => failures.push(`join probe at N=${target} failed: ${String(e)}`));
      }, holdMs * 0.6);
      probeTimer.unref?.();
      await drive(holdMs, stepPings);
      clearTimeout(probeTimer);

      const dt = (Date.now() - winT0) / 1000;
      const cpu1 = procStat(serverPid);
      const botCpu1 = procStat(process.pid);
      const m1 = ATTACH ? null : await scrapeMetrics(port);
      const rssEndStep = cpu1.rssMb;
      const cpuPct = ((cpu1.cpuSec - cpu0.cpuSec) / dt) * 100;
      const perBotBps = bots.map((b, i) => (b.rxBytes - base[i]!.rxBytes) / dt);
      const playerBatchHz = bots.map((b, i) => (b.rxPlayerBatches - base[i]!.pb) / dt);
      const playerEntryHz = bots.map((b, i) => (b.rxPlayerEntries - base[i]!.pe) / dt);
      const actorBatchHz = bots.slice(1).map((b, i) => (b.rxActorBatches - base[i + 1]!.ab) / dt);
      // Visible peers per client: the direct read-out of culling. In cluster layout this
      // must stay at N-1 (the radius never bites); in spread it should fall well below.
      const visiblePeers = bots.map((b) => b.sendersSeen.size);
      const leaveViews = bots.reduce((acc, b, i) => acc + (b.client.inbox.events.filter((e) => e.name === 'PlayerLeaveView').length - leaveView0[i]!), 0);

      // --- quiesce, then CORRECTNESS ---
      actorPaused = true;
      // LOD strides actor batches by distance (worldstate: `(batchNo + p.id) % st`), so a
      // far-tier peer legitimately receives only every 15th frame. Comparing final state
      // straight after the last broadcast would score that lag as DIVERGENCE and blame the
      // relay for the feature working. Re-send the SAME final pose enough consecutive times
      // that every stride is guaranteed a hit, then require exact agreement — which stays a
      // real delivery+agreement assertion, not a softened one.
      for (let i = 0; i < ACTOR_FLUSH_FRAMES; i++) {
        const holder = bots[0];
        if (ONECELL && !ATTACH && holderEpoch !== undefined && holder && !holder.disconnected) {
          holder.client.sendActorMoveBatch(holderEpoch, ACTOR_REFS.map((ref, k) => ({
            ref, pose: { x: actorSeq, y: k * 100, z: 512, yaw: 0, pitch: 128, flags: 0, animVel: 0, counter: 0 },
          })));
        }
        await sleep(66);
      }
      await sleep(2000); // drain anything still in flight before declaring divergence

      // Every non-holder must hold EXACTLY the state the holder last broadcast: all
      // ACTOR_COUNT refs, at the final sequence. "Positions are close" is not a check —
      // a bot that received nothing would trivially satisfy it against its own empty map,
      // which is precisely how a convergence test in this repo once passed with zero
      // puppets attached. Missing refs and stale sequences both count as divergence.
      const expected = new Map(ACTOR_REFS.map((r, i) => [refKey(r), { x: actorSeq, y: i * 100, z: 512 }]));
      const sent = actorSeq - seqStart;
      let divergent = 0;
      let silent = 0;
      let worstLag = 0;
      let missingRefs = 0;
      const dropPcts: number[] = [];
      for (const b of bots.slice(1)) {
        if (b.disconnected) continue;
        if (b.rxActorBatches === 0) { silent++; divergent++; continue; }
        const got = [...b.seqsSeen].filter((s) => s > seqStart).length;
        dropPcts.push(sent > 0 ? Math.max(0, 1 - got / sent) * 100 : 0);
        let bad = false;
        for (const [k, e] of expected) {
          const a = b.actors.get(k);
          if (!a) { bad = true; missingRefs++; continue; }
          const lag = Math.max(Math.abs(a.x - e.x), Math.abs(a.y - e.y), Math.abs(a.z - e.z));
          if (lag > 0) bad = true;
          if (lag > worstLag) worstLag = lag;
        }
        if (bad) divergent++;
      }
      // Was there an actor stream to measure at all? In spread mode nobody claims a cell
      // holder, so no ActorMoveBatch is ever sent and every bot trivially counts as silent
      // and divergent — the run then printed "divergent=23" beside "PASS", which is worse
      // than printing nothing: a number that alarming and that wrong teaches an operator to
      // ignore the column that actually matters in one-cell runs.
      const actorMeasured = sent > 0 || bots.slice(1).some((b) => b.rxActorBatches > 0);
      if (ONECELL && !ATTACH) {
        // The relay excludes the sender: an echo back to the holder would double every
        // client's actor cost and is worth failing on, not just noting.
        if (bots[0]!.rxActorBatches > 0) failures.push(`holder received ${bots[0]!.rxActorBatches} of its own ActorMoveBatch frames (relay echo)`);
        if (silent) failures.push(`N=${target}: ${silent} bot(s) received ZERO ActorMoveBatch frames`);
        if (missingRefs) failures.push(`N=${target}: ${missingRefs} actor ref(s) missing entirely from non-holder state`);
        if (divergent) failures.push(`N=${target}: ${divergent}/${target - 1} non-holders diverged from the holder (worst lag ${worstLag} broadcasts)`);
      }
      actorPaused = false;

      const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
      const row: StepRow = {
        n: target,
        alive: bots.filter((b) => !b.disconnected).length,
        rssMb: rssEndStep,
        cpuPct,
        botCpuPct: ((botCpu1.cpuSec - botCpu0.cpuSec) / dt) * 100,
        layout: LAYOUT,
        visPeersMean: mean(visiblePeers),
        visPeersMax: Math.max(...visiblePeers),
        leaveViews,
        moveShed: m1 && m0 ? m1['move_shed']! - m0['move_shed']! : NaN,
        actorShed: m1 && m0 ? m1['actor_shed']! - m0['actor_shed']! : NaN,
        bpDropped: m1 && m0 ? (m1['bp_move']! - m0['bp_move']!) + (m1['bp_actor']! - m0['bp_actor']!) : NaN,
        bufferedKb: m1 ? m1['buffered']! / 1024 : NaN,
        rxKbMean: mean(perBotBps) / 1024,
        rxKbMax: Math.max(...perBotBps) / 1024,
        aggKbSec: perBotBps.reduce((a, b) => a + b, 0) / 1024,
        playerBatchHz: mean(playerBatchHz),
        playerEntryHz: mean(playerEntryHz),
        actorBatchHz: mean(actorBatchHz),
        actorSentHz: sent / dt,
        actorDropPct: actorMeasured ? mean(dropPcts) : null,
        growJoinMs: mean(growJoins),
        probeWelcomeMs: probeResult.welcomeMs,
        probeFirstBatchMs: probeResult.firstBatchMs,
        pingMean: mean(stepPings),
        pingMax: stepPings.length ? Math.max(...stepPings) : NaN,
        divergent: actorMeasured ? divergent : null,
        worstLag: actorMeasured ? worstLag : null,
      };
      rows.push(row);
      console.log(
        `[step] N=${row.n} alive=${row.alive} rss=${row.rssMb.toFixed(0)}MB cpu=${row.cpuPct.toFixed(0)}% botcpu=${row.botCpuPct.toFixed(0)}% ` +
        `rx/client=${row.rxKbMean.toFixed(1)}KB/s (max ${row.rxKbMax.toFixed(1)}) agg=${row.aggKbSec.toFixed(0)}KB/s ` +
        `pmb=${row.playerBatchHz.toFixed(1)}/s entries=${row.playerEntryHz.toFixed(1)}/s ` +
        `amb=${row.actorBatchHz.toFixed(1)}/s of ${row.actorSentHz.toFixed(1)} sent ` +
        `(undelivered ${row.actorDropPct === null ? 'n/a' : row.actorDropPct.toFixed(2) + '%'}) ` +
        `vis=${row.visPeersMean.toFixed(1)}/${row.n - 1} leaveView=${row.leaveViews} ` +
        `join=${row.probeWelcomeMs.toFixed(0)}ms/+batch ${row.probeFirstBatchMs.toFixed(0)}ms ` +
        `ping=${row.pingMean.toFixed(0)}/${row.pingMax}ms shed=${row.moveShed}/${row.actorShed} bp=${row.bpDropped} ` +
        `buf=${row.bufferedKb.toFixed(1)}KB ` +
        `divergent=${row.divergent === null ? 'n/a (no actor stream)' : row.divergent} ` +
        `worstLag=${row.worstLag === null ? 'n/a' : row.worstLag}`,
      );
    }

    // --- PUBLIC-LAUNCH GATE (plan Phase 2.4) -------------------------------------------
    // The public realm concentrates players in towns by design, and cell authority is a
    // CLIENT. Before public opens, one crowded cell must hold these lines — not "look
    // roughly fine", which is how TES3MP #701 (broken combat gamestate for non-authority
    // clients under crowding) went unnoticed for years. Thresholds are per-step, so a
    // ramp reports the N at which the world stops being playable rather than a verdict.
    //
    // Run: npm run soak -- --ramp --onecell --steps 8,16,24,32
    // Override for a bigger box with GATE_* env; the defaults are what a 2-vCPU tier
    // must sustain.
    if (RAMP) {
      const maxUndeliv = Number(process.env.GATE_UNDELIVERED_PCT ?? 2);
      const maxPing = Number(process.env.GATE_PING_MS ?? 250);
      const maxJoin = Number(process.env.GATE_JOIN_MS ?? 5000);
      const maxRxKb = Number(process.env.GATE_RX_KB ?? 120);
      let lastGood = 0;
      for (const r of rows) {
        const bad: string[] = [];
        // Correctness first: a client that is not receiving the actor stream is watching
        // a different fight from everyone else, which is the #701 failure exactly.
        if (r.actorDropPct !== null && r.actorDropPct > maxUndeliv) bad.push(`undelivered ${r.actorDropPct.toFixed(1)}% > ${maxUndeliv}%`);
        if (r.divergent !== null && r.divergent > 0) bad.push(`${r.divergent} divergent actor position(s)`);
        if (r.alive < r.n) bad.push(`${r.n - r.alive} client(s) dropped`);
        // Then playability.
        if (Number.isFinite(r.pingMax) && r.pingMax > maxPing) bad.push(`ping max ${r.pingMax}ms > ${maxPing}ms`);
        if (r.probeWelcomeMs > maxJoin) bad.push(`join ${r.probeWelcomeMs.toFixed(0)}ms > ${maxJoin}ms`);
        if (r.rxKbMax > maxRxKb) bad.push(`per-client ${r.rxKbMax.toFixed(0)}KB/s > ${maxRxKb}KB/s`);
        if (bad.length === 0) lastGood = r.n;
        else console.log(`[gate] N=${r.n} FAILS: ${bad.join('; ')}`);
      }
      console.log(`[gate] highest N meeting the public-launch bar in ONE cell: ${lastGood}`);
      // The gate is a measurement, not a build break: a workstation ramp that thrashes at
      // 32 says nothing about the deploy tier. It fails the run only when even the FIRST
      // step cannot hold the line, which is a real regression wherever it is measured.
      if (lastGood === 0 && rows.length > 0) {
        failures.push(`crowded-cell gate: even N=${rows[0]!.n} misses the public-launch bar`);
      }
    }

    console.log(`\n[soak] ramp table (layout=${LAYOUT})`);
    console.log('  N | alive | vis peers | RSS MB | CPU % | bot CPU % | rx KB/s/client | agg KB/s | PMB/s | poses/s | AMB/s | undeliv % | join ms | +1st batch | ping ms | move shed | actor shed | bp drop | buf KB | divergent | worst lag');
    for (const r of rows) {
      console.log(
        `  ${String(r.n).padStart(2)} | ${String(r.alive).padStart(5)} | ${r.visPeersMean.toFixed(1).padStart(9)} | ${r.rssMb.toFixed(0).padStart(6)} | ${r.cpuPct.toFixed(0).padStart(5)} | ${r.botCpuPct.toFixed(0).padStart(9)} | ` +
        `${r.rxKbMean.toFixed(1).padStart(14)} | ${r.aggKbSec.toFixed(0).padStart(8)} | ${r.playerBatchHz.toFixed(1).padStart(5)} | ` +
        `${r.playerEntryHz.toFixed(1).padStart(7)} | ${r.actorBatchHz.toFixed(1).padStart(5)} | ${(r.actorDropPct === null ? '-' : r.actorDropPct.toFixed(2)).padStart(6)} | ` +
        `${r.probeWelcomeMs.toFixed(0).padStart(7)} | ${r.probeFirstBatchMs.toFixed(0).padStart(10)} | ${r.pingMean.toFixed(0).padStart(7)} | ` +
        `${String(r.moveShed).padStart(9)} | ${String(r.actorShed).padStart(10)} | ${String(r.bpDropped).padStart(7)} | ` +
        `${r.bufferedKb.toFixed(1).padStart(6)} | ` +
        `${String(r.divergent ?? '-').padStart(9)} | ${String(r.worstLag ?? '-').padStart(9)}`,
      );
    }

    // --- assertions --------------------------------------------------------------------
    const rssEnd = rssMb(serverPid);
    const alive = bots.filter((b) => !b.disconnected).length;
    if (alive !== MAX_BOTS) failures.push(`${MAX_BOTS - alive} bot(s) disconnected unexpectedly`);

    // Leak check: compare the second half's mean against the first half's. A healthy
    // server plateaus; steady growth across a multi-minute run is the signal we want.
    // Meaningless during a ramp — RSS is SUPPOSED to grow as the fleet quadruples — so the
    // ramp reports per-step RSS in the table instead and skips the leak gate.
    // --attach measures someone else's server: no pid, no RSS series, nothing to gate on.
    const half = RAMP || ATTACH ? 0 : Math.floor(samples.length / 2);
    if (half >= 2) {
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const first = mean(samples.slice(0, half).map((s) => s.rss));
      const second = mean(samples.slice(half).map((s) => s.rss));
      const growth = second - first;
      console.log(`[soak] RSS ${rssStart.toFixed(0)} -> ${rssEnd.toFixed(0)} MB (half-means ${first.toFixed(0)} -> ${second.toFixed(0)}, growth ${growth.toFixed(1)} MB)`);
      if (growth > 50) failures.push(`RSS grew ${growth.toFixed(1)}MB between run halves (possible leak)`);
    }
    if (!ATTACH && rssEnd > 384) failures.push(`RSS ${rssEnd.toFixed(0)}MB exceeds the compose mem_limit budget (384MB)`);

    const latencies = samples.map((s) => s.latency).filter((n) => !Number.isNaN(n));
    if (latencies.length) {
      const worst = Math.max(...latencies);
      console.log(`[soak] ping max=${worst}ms mean=${(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(0)}ms`);
      if (worst > 2000) failures.push(`worst ping ${worst}ms — server stalled under load`);
    }

    const status = await (await fetch(`http://127.0.0.1:${port}/status`)).json() as { players: unknown[] };
    if (!ATTACH && status.players.length !== alive) {
      failures.push(`/status reports ${status.players.length} players but ${alive} bots are alive (session leak)`);
    }
    console.log(`[soak] chats sent=${chatsSent}, server reports ${status.players.length} players`);

    // --- correctness invariants, checked AFTER sustained concurrent load ----------------
    const probe = bots.find((b) => !b.disconnected);
    if (probe) {
      // Journal: interleaved advances and deliberately stale (index=1) writes from many
      // players must leave the shared stage at the max ever sent, never rewound.
      const seenStages = probe.client.inbox.events
        .filter((e) => e.name === 'JournalEntry')
        .map((e) => Number((e.value as { index?: number }).index ?? 0));
      if (seenStages.length) {
        const relayedMax = Math.max(...seenStages);
        let prev = 0;
        for (const s of seenStages) {
          if (s < prev) failures.push(`journal stage went BACKWARDS in the relay stream: ${prev} -> ${s}`);
          prev = Math.max(prev, s);
        }
        if (relayedMax > journalStage) failures.push(`journal relayed stage ${relayedMax} > max sent ${journalStage}`);
        console.log(`[soak] journal: ${seenStages.length} relays, max stage ${relayedMax}/${journalStage}, monotonic OK`);
      }
      // Records: every accepted RecordCreate must have produced exactly one unique id.
      const ids = probe.client.inbox.events
        .filter((e) => e.name === 'RecordCreateAck' || e.name === 'RecordsSync')
        .flatMap((e) => {
          const v = e.value as { recordNetId?: string; records?: { recordNetId?: string }[] };
          return v.recordNetId ? [v.recordNetId] : (v.records ?? []).map((r) => r.recordNetId ?? '');
        })
        .filter(Boolean);
      if (new Set(ids).size !== ids.length) failures.push(`duplicate recordNetId issued under load (${ids.length} ids, ${new Set(ids).size} unique)`);
      // PvP off (default): no player-targeted hit may ever be delivered.
      const leakedHits = bots.filter((b) => b.client.inbox.events.some((e) => e.name === 'CombatHit'));
      if (leakedHits.length) failures.push(`pvp is off but ${leakedHits.length} bot(s) received a CombatHit`);
      console.log(`[soak] records: ${new Set(ids).size} unique ids; pvp-off leak check clean`);
    }
  } finally {
    for (const b of bots) { try { b.client.ws.close(); } catch {} }
    await sleep(500);
    server?.kill('SIGTERM');
    // A profiled server must be allowed to exit on its own or V8 never flushes the
    // .cpuprofile; unprofiled runs keep the old short leash.
    if (server && CPUPROF) {
      const exited = new Promise<void>((r) => server!.once('exit', () => r()));
      await Promise.race([exited, sleep(30_000)]);
    } else {
      await sleep(1500);
    }
    server?.kill('SIGKILL');
    if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch {} }
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
