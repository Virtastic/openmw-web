// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s42 (Phase D): CROWDED CELL. Every real browser client the machine can host, plus a wave
// of protocol bots, all in ONE retail cell — the case the spread-across-cells soak never
// touches and the one this project's inherited TES3MP design is weakest at (one client
// simulates every NPC in a cell and broadcasts to everyone else; TES3MP #701 reports
// non-authority clients getting broken combat gamestate under exactly this shape).
//
// What is asserted, in order of what actually matters:
//   1. Exactly ONE authority holder for the shared cell, with every other client told who.
//   2. Non-holders are really PUPPETING the cell's actors (puppetedActors > 0). Without
//      this, step 3 is meaningless: two clients running independent AI from identical
//      spawns agree by luck, and a convergence check in this repo has already passed once
//      with ZERO puppets attached.
//   3. Cross-client agreement on shared actor positions holds WHILE the cell is crowded —
//      measured before the bots arrive and again at full load, so the report can say
//      whether crowding degrades correctness rather than just whether it passed.
//
// Client count is machine-bound, not spec-bound: each retail client pins ~1.5 GB and boots
// are serialized by the harness. Override with S42_CLIENTS / S42_BOTS.
//
// RETAIL DATA REQUIRED (the clean Example Suite ships no NPCs at all — see s40).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
// Default 2, not 4. Each retail client pins ~1.5 GB of WASM heap, so 4 needs ~6 GB of
// headroom; on a workstation already using swap the machine thrashes, boots take minutes,
// and the clients go unresponsive enough that authority mirrors read stale — a run at 4
// took 91 minutes here and reported no authority holder at all, which is a measurement of
// the box, not of the server. 2 is what this scenario can assert honestly; raise
// S42_CLIENTS on a machine with the RAM to back it (check swap first, not just total RAM).
const CLIENTS = Number(process.env.S42_CLIENTS ?? 2);
const BOTS = Number(process.env.S42_BOTS ?? 20);
const BOT_MINUTES = Number(process.env.S42_BOT_MINUTES ?? 2);
const CONVERGE_EPS = 80; // units; same budget as s40 (puppet steering + 100ms render delay)
const STEP_TIMEOUT = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };

// maxConnsPerIp defaults to 3 and every bot dials from 127.0.0.1 — without this the crowd
// is refused before any load is applied. Appended as raw TOML after the [rules] table.
// enforce = "off": ContentGate makes the FIRST client's manifest canonical, and the retail
// browser clients join before the bots — so every bot would be refused BAD_CONTENT and the
// crowd would never materialise, leaving the convergence checks below to pass against an
// uncrowded cell. See s43 for the same note.
export const serverRules =
  `\n[server]\nmaxPlayers = ${(CLIENTS + BOTS) * 2 + 16}\n`
  + `\n[content]\nenforce = "off"\n`
  + `\n[limits]\nmaxConnsPerIp = ${(CLIENTS + BOTS) * 4 + 16}\nloginPerMinPerIp = 100000\n`;

const probeOf = async (c) => JSON.parse(await c.eval('(window.__omwMP||{}).actorProbe||"{}"'));
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

// The client mirror has no cellKey of its own, but actorCensus tags every active actor with
// one ("player@-2,-9"), and the local player is always in its own cell.
async function cellKeyOf(c) {
  const census = JSON.parse(await c.eval('(window.__omwMP||{}).actorCensus||"[]"'));
  const me = census.find((e) => e.startsWith('player@'));
  if (!me) throw new Error(`[${c.name}] actorCensus has no player entry: ${JSON.stringify(census)}`);
  return me.slice('player@'.length);
}

// Worst pairwise disagreement across every client, over records ALL of them can see.
// Returns null when there is nothing shared to compare — reported, never silently passed.
async function worstDisagreement(clients) {
  const probes = await Promise.all(clients.map(probeOf));
  const shared = Object.keys(probes[0]).filter((r) => probes.every((p) => p[r]));
  if (shared.length === 0) return { shared: 0, worst: null, rec: null };
  let worst = 0;
  let rec = null;
  for (const r of shared) {
    for (let i = 1; i < probes.length; i++) {
      const d = dist(probes[0][r], probes[i][r]);
      if (d > worst) { worst = d; rec = r; }
    }
  }
  return { shared: shared.length, worst, rec };
}

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required for shared NPCs)');
    return;
  }
  if (!(CLIENTS >= 2)) throw new Error(`S42_CLIENTS must be >= 2 (cross-client agreement needs two), got ${CLIENTS}`);

  ctx.log(`crowding one cell with ${CLIENTS} browser clients + ${BOTS} protocol bots`);
  const clients = [];
  for (let i = 0; i < CLIENTS; i++) clients.push(await ctx.launchClient(`crowd${i}`, '', BOOT));

  for (const c of clients) {
    await c.waitFor('Number((window.__omwMP||{}).actorCount||0) > 0', STEP_TIMEOUT, `${c.name} sees cell actors`);
  }
  const cellKeys = await Promise.all(clients.map(cellKeyOf));
  ctx.log(`cell keys: ${cellKeys.join(' ')}`);
  assert.ok(new Set(cellKeys).size === 1, `clients must share one cell, got ${JSON.stringify(cellKeys)}`);
  const cellKey = cellKeys[0];

  // 1. Exactly one holder, and every non-holder knows who it is.
  let flags = [];
  const authDeadline = Date.now() + STEP_TIMEOUT;
  while (Date.now() < authDeadline) {
    flags = await Promise.all(clients.map((c) => c.eval('(window.__omwMP||{}).isHolder')));
    if (flags.filter((h) => h === 'true').length === 1) break;
    await ctx.sleep(500);
  }
  ctx.log(`isHolder: ${clients.map((c, i) => `${c.name}=${flags[i]}`).join(' ')}`);
  if (flags.filter((h) => h === 'true').length !== 1) {
    // isHolder alone cannot distinguish "nobody was ever granted" from "granted under a
    // cellKey the client mirror is not looking at" — and those need completely different
    // fixes. Dump what each client believes before failing, so the next run does not have
    // to be a second experiment just to learn which one it is.
    for (const c of clients) {
      const holderId = await c.eval('(window.__omwMP||{}).authorityHolder');
      const myId = await c.eval('(window.__omwMP||{}).playerId');
      const census = await c.eval('(window.__omwMP||{}).actorCensus||"[]"');
      const me = JSON.parse(census).find((e) => e.startsWith('player@')) ?? 'none';
      ctx.log(`  ${c.name}: id=${myId} authorityHolder=${holderId} cellPerCensus=${me}`);
    }
  }
  assert.equal(flags.filter((h) => h === 'true').length, 1,
    `exactly one client must hold ${cellKey}, got ${JSON.stringify(flags)}`);
  const holder = clients[flags.indexOf('true')];
  const peers = clients.filter((c) => c !== holder);
  // Both mirrors are strings formatted by different call sites ('%.0f' vs tostring), so
  // compare numerically rather than trusting them to render identically.
  const holderId = Number(await holder.eval('(window.__omwMP||{}).playerId'));
  assert.ok(Number.isInteger(holderId), `holder has no usable playerId: ${holderId}`);
  for (const p of peers) {
    await p.waitFor(`Number((window.__omwMP||{}).authorityHolder) === ${holderId}`,
      STEP_TIMEOUT, `${p.name} learned holder=${holderId}`);
  }

  // 2. Non-holders must actually be puppeting. Asserted BEFORE any convergence number is
  //    believed — see the header note about the zero-puppet false green.
  for (const p of peers) {
    await p.waitFor('Number((window.__omwMP||{}).puppetedActors||0) >= 3', STEP_TIMEOUT,
      `${p.name} attached puppets to the cell actors`);
  }
  ctx.log(`holder=${holder.name} (id ${holderId}); ${peers.length} non-holders puppeting`);

  // Baseline agreement with only the browser clients present.
  let before = { shared: 0, worst: null, rec: null };
  const beforeDeadline = Date.now() + STEP_TIMEOUT;
  while (Date.now() < beforeDeadline) {
    before = await worstDisagreement(clients);
    if (before.shared >= 3 && before.worst !== null && before.worst < CONVERGE_EPS) break;
    await ctx.sleep(500);
  }
  ctx.log(`baseline (${clients.length} clients): ${before.shared} shared NPCs, worst ${before.worst?.toFixed(1)} units (${before.rec})`);
  assert.ok(before.shared >= 3, `expected >=3 shared NPCs, got ${before.shared}`);
  assert.ok(before.worst < CONVERGE_EPS, `clients diverged before any crowd load: ${before.worst?.toFixed(1)} units`);

  // 3. Crowd the cell with protocol bots on the SAME server and cell, then re-measure.
  //    --attach: the bots do not spawn their own server and do not claim authority (the
  //    browser holder already has it), so they are pure fan-out load and pure receivers.
  const soak = spawn('npx', ['tsx', 'bots/soak.ts',
    '--attach', String(ctx.serverPort), '--onecell', '--cellkey', cellKey,
    '--bots', String(BOTS), '--minutes', String(BOT_MINUTES)],
    { cwd: join(ROOT, 'server'), stdio: ['ignore', 'pipe', 'pipe'] });
  const soakOut = [];
  soak.stdout.on('data', (d) => soakOut.push(String(d)));
  soak.stderr.on('data', (d) => soakOut.push(String(d)));
  const soakDone = new Promise((resolve) => soak.on('exit', (code) => resolve(code)));
  let botFailure;

  try {
    // Wait for the bots to actually be in the cell — asserting agreement "under load" while
    // the load has not arrived yet is the same false green as an unpuppeted convergence check.
    const wantPlayers = clients.length + BOTS;
    const loadDeadline = Date.now() + 120_000;
    let players = 0;
    while (Date.now() < loadDeadline) {
      players = (await ctx.serverStatus()).players.length;
      if (players >= wantPlayers) break;
      await ctx.sleep(1000);
    }
    ctx.log(`server reports ${players} players (wanted >= ${wantPlayers})`);
    assert.ok(players >= wantPlayers, `crowd never fully joined: ${players}/${wantPlayers}`);

    // Sustained sampling, not a single lucky read: take the WORST agreement seen while the
    // cell is crowded. Also track that the puppet stream keeps flowing (actorBatchesIn must
    // keep rising) — frozen puppets hold their last position and would look "converged".
    const batches0 = await Promise.all(peers.map((p) => p.eval('Number((window.__omwMP||{}).actorBatchesIn||0)')));
    let under = { shared: 0, worst: 0, rec: null };
    const sampleEnd = Date.now() + 60_000;
    while (Date.now() < sampleEnd) {
      const s = await worstDisagreement(clients);
      if (s.worst === null) { under = s; break; }
      if (s.worst > under.worst) under = s;
      await ctx.sleep(2000);
    }
    const batches1 = await Promise.all(peers.map((p) => p.eval('Number((window.__omwMP||{}).actorBatchesIn||0)')));
    const stalled = peers.filter((_, i) => batches1[i] <= batches0[i]).map((p) => p.name);
    ctx.log(`under load (${clients.length} clients + ${BOTS} bots): ${under.shared} shared NPCs, `
      + `worst ${under.worst === null ? 'n/a' : under.worst.toFixed(1)} units (${under.rec}); `
      + `actorBatchesIn ${batches0.join(',')} -> ${batches1.join(',')}`);

    assert.equal(stalled.length, 0, `puppet stream stalled under load on: ${stalled.join(', ')}`);
    assert.ok(under.shared >= 3, `shared NPC set collapsed under load: ${under.shared}`);
    assert.ok(under.worst < CONVERGE_EPS,
      `cross-client actor state diverged under crowd load: ${under.worst.toFixed(1)} units `
      + `(baseline was ${before.worst.toFixed(1)}) — this is the per-cell correctness cap`);

    // Authority must not have wandered while the crowd joined: a handoff mid-measurement
    // would make every number above unattributable.
    const stillHolder = await holder.eval('(window.__omwMP||{}).isHolder');
    assert.equal(stillHolder, 'true', `authority left ${holder.name} during the crowd load`);
    ctx.log(`ok: ${clients.length} browser clients agreed on shared actor state with ${BOTS} bots in ${cellKey}`);
    botFailure = await reapBots();
  } finally {
    // Never let bot teardown mask the real assertion failure above: reap, log, and only
    // raise the bot result when nothing else already failed.
    if (botFailure === undefined) await reapBots();
  }
  if (botFailure) throw new Error(botFailure);

  async function reapBots() {
    const code = await Promise.race([soakDone, ctx.sleep(90_000).then(() => 'timeout')]);
    if (code === 'timeout') { try { soak.kill('SIGKILL'); } catch {} }
    // The bots' own invariants (drop-free relay, no session leak) are part of this result,
    // so a nonzero soak exit is reported with its output rather than discarded.
    ctx.log(`soak bots exited ${code}\n${soakOut.join('').split('\n').slice(-25).join('\n')}`);
    return code !== 0 && code !== 'timeout' ? `crowd bots failed (exit ${code}) — see output above` : '';
  }
}
