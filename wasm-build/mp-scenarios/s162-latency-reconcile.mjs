// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s162: A WALK ON A REAL LINK DOES NOT RUBBER-BAND. The world server shapes every socket
// (players and the sim peer) with a 150 ms round trip (OMWMP_NET_DELAY_MS, backlog #212).
// The peer's pose acknowledges an input from one RTT ago; reconciling it against where the
// owner stands NOW dragged every stop back by RTT x speed (#197). Fixed, the owner walks
// forward monotonically and, once stopped, the avatar's pose agrees with where they were
// when that input left.
import assert from 'node:assert/strict';

export const serverEnv = { OMWMP_NET_DELAY_MS: '150' };

const BOOT = { retail: true, joinTimeoutMs: 420_000 };
// FIFTEEN SECONDS OF WALL CLOCK, NOT FOUR. The engine integrates movement per FRAME with a
// clamped delta, and a streamed retail harness client renders at ~1 fps: 4 s of wall clock
// bought 0.8 s of walking and 85 units (#106), under the 100 this asks for. The same clamp is
// why s149 holds its breath for 240 s to spend 20 s of game time. The walk is the setup, not
// the measurement: the rubber-band and divergence checks read the same samples either way.
const WALK_MS = 15000;
const BACKWARD_TOLERANCE = 20; // units; RTT x walk speed is ~25+ without the ring
const SETTLED_DIVERGENCE = 10;

const pose = async (c) => JSON.parse(await c.eval('window.omw.state.pose||"null"'));

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const a = await ctx.launchClient('bot-a', '', BOOT);
  await a.waitFor('String(window.omw.state.baselineReady||"") === "1"', 120_000, 'the character is settled (the join-time restore is done)');
  await a.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 120_000, 'the cell is peer-held');
  await a.waitFor('typeof window.omw.state.selfDivergence === "string"', 60_000, 'the avatar rules our pose');
  ctx.log(`ok: peer-held, delay 150 ms, divergence at rest ${await a.eval('window.omw.state.selfDivergence')}`);

  // Walk +Y for 4 s; the pose mirror is 2 Hz. Sample through the walk and the stop.
  const start = await pose(a);
  await a.cmd(`walk:0,1,${WALK_MS}`);
  const samples = [];
  const until = Date.now() + WALK_MS + 500;
  while (Date.now() < until) {
    samples.push({ ...(await pose(a)), div: Number(await a.eval('window.omw.state.selfDivergence||0')) });
    await ctx.sleep(500);
  }
  let worst = 0;
  for (let i = 1; i < samples.length; i++) worst = Math.max(worst, samples[i - 1].y - samples[i].y);
  const walked = samples[samples.length - 1].y - start.y;
  ctx.log(`walked ${walked.toFixed(0)} units in +Y; worst step back ${worst.toFixed(1)}; divergence ${samples.map((s) => s.div.toFixed(0)).join(' ')}`);
  assert.ok(walked > 100, `the walk barely moved (${walked.toFixed(0)} units)`);
  assert.ok(worst <= BACKWARD_TOLERANCE, `rubber-band: Y went back ${worst.toFixed(1)} units in one 500 ms sample`);

  // Stopped: the avatar catches up within a couple of RTTs and the divergence settles.
  await ctx.sleep(2000);
  let best = Infinity;
  for (let i = 0; i < 6; i++) {
    best = Math.min(best, Number(await a.eval('window.omw.state.selfDivergence||0')));
    if (best < SETTLED_DIVERGENCE) break;
    await ctx.sleep(500);
  }
  ctx.log(`settled divergence ${best.toFixed(1)}`);
  assert.ok(best < SETTLED_DIVERGENCE, `divergence after the stop stayed at ${best.toFixed(1)} (want < ${SETTLED_DIVERGENCE})`);
}
