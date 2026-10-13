// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s184: FARGOTH WALKS TO HIS STUMP. A playtester: "i cant get fargoth to walk his fat ass over
// to the stump". The walk is lookoutScript on active_lookout_unique (Morrowind.esm), the
// activator on top of Seyda Neen's lighthouse: with MS_Lookout at 20, the hour past 22 and the
// player within 512 u of it, it chains seven AiTravel legs (tree, wall, shore, tree, pond,
// town, his door), each one started only when Fargoth->GetAiPackageDone says the last finished.
// Every link of that chain is a multiplayer seam: the script runs on the watching player's
// client, whose Fargoth is a puppet with its AI off; the AiTravel goes out as a travel claim
// (worldstate.ts admission); the HOLDER walks him; the holder's "done" comes back as an aidone
// note so the client's poller can start the next leg (backlog 221, aisequence.cpp mDone).
//
// Asserted on B -- who is nowhere near the lighthouse and ran none of it: Fargoth reaches the
// tree, then the wall, then the shore. Reaching the wall proves one GetAiPackageDone round
// trip; the shore proves two. Also measured on B, not asserted: how his walk LOOKS (the
// "npcs are a little jerky" report) -- per-sample speed and any step backwards.
//
// RETAIL DATA REQUIRED.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
export const bootTimeoutMs = 420_000;

const LOOKOUT = { x: -12090, y: -74375, z: 1152 }; // active_lookout_unique, the lighthouse top
// lookoutScript's AiTravel targets, in order.
const LEGS = [
  ['tree', { x: -11468.6, y: -71511.5 }],
  ['wall', { x: -11410.6, y: -72057.2 }],
  ['shore', { x: -11809.1, y: -72958.9 }],
];
const ARRIVED = 200; // AiTravel stops within ~64 u; a puppet trails its holder a little
const LEG_TIMEOUT = 120_000;

const probeOf = async (c) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'));
const d2 = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required)');
    return;
  }
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const [a, b] = await Promise.all([ctx.launchClient('lookout-a', '', BOOT), ctx.launchClient('lookout-b', '', BOOT)]);
  for (const c of [a, b]) {
    await c.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 300_000, `${c.name} puppeted the cell actors (the peer holds Seyda Neen)`);
  }
  await b.waitFor('!!JSON.parse(window.omw.state.actorProbe||"{}").fargoth', 60_000, 'B sees Fargoth');
  const f0 = (await probeOf(b)).fargoth;
  ctx.log(`Fargoth at (${Math.round(f0.x)},${Math.round(f0.y)}) puppet=${f0.puppet}`);

  // Night: the script waits for GameHour >= 22 (or <= 4). Rest on A to 23:00.
  const hourOf = async () => JSON.parse(await a.eval('window.omw.state.gameTime||"{}"')).gameHour;
  const h0 = await hourOf();
  if (!(h0 >= 22 || h0 <= 4)) await a.cmd(`rest:${(23 - h0 + 24) % 24}`);
  await a.waitFor('(function(h){ return h >= 22 || h <= 4; })(JSON.parse(window.omw.state.gameTime||"{}").gameHour)', 30_000, 'night on A');
  ctx.log(`hour ${h0} -> ${await hourOf()}`);

  // Hrisskar's errand taken (MS_Lookout 20), then stand on the lighthouse.
  await a.cmd('quest:ms_lookout:20');
  // snapto's onGround traces to the LAND (z 143 under the tower, 1011 u off). So go to the
  // tower's foot, then tpz straight up (no ground trace) and let A drop onto the top; try a few
  // spots, the gallery is narrower than a guess.
  let pa = null, fromLookout = Infinity;
  await a.cmd('sethpbase:5000'); await a.cmd('sethp:5000'); // a missed gallery is a 1000 u fall
  for (const [ox, oy] of [[0, 0], [96, 0], [-96, 0], [0, 96], [0, -96], [160, 0], [0, 160]]) {
    await a.cmd(`snapto:${LOOKOUT.x + ox},${LOOKOUT.y + oy},${LOOKOUT.z}`);
    await ctx.sleep(2_500);
    const g = JSON.parse(await a.eval('window.omw.state.pose||"null"'));
    await a.cmd(`tpz:${Math.round(LOOKOUT.z + 80 - g.z)}`);
    await ctx.sleep(4_000);
    pa = JSON.parse(await a.eval('window.omw.state.pose||"null"'));
    fromLookout = Math.hypot(pa.x - LOOKOUT.x, pa.y - LOOKOUT.y, pa.z - LOOKOUT.z);
    ctx.log(`  try (${ox},${oy}): landed z=${Math.round(pa.z)}, ${Math.round(fromLookout)} u from the lookout`);
    if (fromLookout < 400) break;
  }
  ctx.log(`A at (${Math.round(pa.x)},${Math.round(pa.y)},${Math.round(pa.z)}), ${Math.round(fromLookout)} u from the lookout`);
  assert.ok(fromLookout < 512, `A must stand within 512 u of the lookout to start the walk (${Math.round(fromLookout)} u)`);

  // Follow him on B's screen, one sample a second.
  const samples = [];
  let legIdx = 0;
  const legAt = [];
  const t0 = Date.now();
  while (legIdx < LEGS.length) {
    const [name, target] = LEGS[legIdx];
    if (Date.now() - (legAt.at(-1) ?? t0) > LEG_TIMEOUT) {
      const last = samples.at(-1);
      throw new Error(`Fargoth never reached the ${name} on B: last seen (${last ? `${Math.round(last.x)},${Math.round(last.y)}` : 'never'}), `
        + `${last ? Math.round(d2(last, target)) : '?'} u off, after ${legIdx} leg(s)`);
    }
    const f = (await probeOf(b)).fargoth;
    if (f) {
      samples.push({ t: Date.now(), x: f.x, y: f.y });
      if (d2(f, target) < ARRIVED) {
        legAt.push(Date.now());
        ctx.log(`ok: Fargoth at the ${name} on B after ${Math.round((Date.now() - t0) / 1000)} s`);
        legIdx++;
      }
    }
    await ctx.sleep(1_000);
  }

  // How the walk looked on B: speed between samples, and steps that went back on themselves.
  let back = 0, maxSpeed = 0;
  const speeds = [];
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i], p = samples[i - 1];
    const v = Math.hypot(s.x - p.x, s.y - p.y) / ((s.t - p.t) / 1000);
    speeds.push(v); maxSpeed = Math.max(maxSpeed, v);
    if (i > 1) {
      const q = samples[i - 2];
      const dot = (s.x - p.x) * (p.x - q.x) + (s.y - p.y) * (p.y - q.y);
      if (dot < 0 && Math.hypot(s.x - p.x, s.y - p.y) > 20) back++;
    }
  }
  speeds.sort((x, y) => x - y);
  ctx.log(`walk on B: ${samples.length} samples, median ${Math.round(speeds[speeds.length >> 1] || 0)} u/s, max ${Math.round(maxSpeed)} u/s, ${back} reversal(s) > 20 u`);
  assert.deepEqual(a.luaErrors(), [], 'no Lua error on A (the client running lookoutScript)');
  ctx.log('ok: lookoutScript walked Fargoth tree -> wall -> shore, two GetAiPackageDone round trips, on a screen that ran none of it');
}
