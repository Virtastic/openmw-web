// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s10 (M1): movement + puppets. Both clients spawn in Village, so each must get a puppet of
// the other (server force-includes poses on visibility). Then A walks forward via the harness
// 'walk' injection; B's puppet-of-A must track and converge on A's real pose.
//
// Mirrors used (2 Hz each): omw.state.pose = own {x,y,z} (player.lua), omw.state.puppets =
// {"<id>":{x,y,z}} of the puppet OBJECT positions (global.lua).
import assert from 'node:assert/strict';
import os from 'node:os';

const PUPPET_SPAWN_TIMEOUT = 15_000;
const WALK_MS = 3000;
const CONVERGE_TIMEOUT = 10_000;
const CONVERGE_EPS = 48; // units; puppet steering + 100ms render delay + 2Hz mirrors

const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

export default async function run(ctx) {
  const [a, b] = await Promise.all([
    ctx.launchClient('bot-a'),
    ctx.launchClient('bot-b'),
  ]);

  const idA = await a.eval('window.omw.state.playerId');
  const idB = await b.eval('window.omw.state.playerId');
  assert.ok(idA && idB, 'both clients must have playerIds');

  // Same cell -> mutual visibility -> each spawns a puppet of the other.
  const puppetExpr = (id) => `!!(JSON.parse(window.omw.state.puppets||"{}")[${JSON.stringify(id)}])`;
  await a.waitFor(puppetExpr(idB), PUPPET_SPAWN_TIMEOUT, `puppet of ${b.name} on A`);
  await b.waitFor(puppetExpr(idA), PUPPET_SPAWN_TIMEOUT, `puppet of ${a.name} on B`);
  ctx.log('ok: both puppets spawned');

  const poseOf = async (c) => JSON.parse(await c.eval('window.omw.state.pose||"null"'));
  const puppetOf = async (c, id) => JSON.parse(await c.eval('window.omw.state.puppets||"{}"'))[id] || null;

  const startPose = await poseOf(a);
  assert.ok(startPose, 'A must mirror its own pose');

  // Drive A forward (walk injection overrides the omw input controls for the duration).
  await a.eval(`window.omw.send('walk:0,1,${WALK_MS}')`);
  await ctx.sleep(WALK_MS + 500);
  const endPose = await poseOf(a);
  const walked = dist(startPose, endPose);
  ctx.log(`A walked ${walked.toFixed(1)} units`);
  assert.ok(walked > 100, `walk injection barely moved A (${walked.toFixed(1)} units)`);

  // B's puppet-of-A must converge on A's real pose (both mirrors are 2 Hz, so give slack).
  // TEN SECONDS OF B'S SIMULATION, not of the wall clock (#152): the engine simulates at most
  // 200 ms a frame, so at the builder's 0.5 fps (SwiftShader) B lived 10 s of wall time as 1 s
  // and its puppet had walked a few steps when the clock ran out. Still judged, never skipped.
  const fps = JSON.parse(await b.evalAsync('new Promise(function(r){var n=0,t0=performance.now();function f(){n++; if(performance.now()-t0<2000) requestAnimationFrame(f); else r(JSON.stringify({fps:n/((performance.now()-t0)/1000)}));} requestAnimationFrame(f);})')).fps;
  const slow = Math.min(12, 1 / Math.min(1, fps * 0.2));
  ctx.log(`B renders ${fps.toFixed(1)} fps: converge window ${(CONVERGE_TIMEOUT * slow / 1000).toFixed(0)} s of wall time`);
  const deadline = Date.now() + CONVERGE_TIMEOUT * slow;
  let err = Infinity;
  let best = Infinity;
  while (Date.now() < deadline) {
    const [pa, pb] = await Promise.all([poseOf(a), puppetOf(b, idA)]);
    if (pa && pb) {
      err = dist(pa, pb);
      best = Math.min(best, err);
      if (err < CONVERGE_EPS) break;
    }
    await ctx.sleep(400);
  }
  const hostLoad = os.loadavg()[0];
  ctx.log(`puppet-of-A on B: final error ${err.toFixed(1)} units (best ${best.toFixed(1)}) `
    + `at ${fps.toFixed(1)} fps, host load ${hostLoad.toFixed(1)}`);
  // A DIVERGENCE FAILS, WHATEVER THE LOAD. This used to SKIP above load 12, and a loaded
  // builder turned every real divergence into "did not run" (backlog 244). The load average
  // is printed as context for the reader, not consulted for the verdict.
  assert.ok(err < CONVERGE_EPS,
    `puppet did not converge: ${err.toFixed(1)} units (eps ${CONVERGE_EPS}) at host load `
    + hostLoad.toFixed(1));

  // And the reverse direction: B stands still, A's puppet-of-B must sit near B's pose.
  const [pbReal, pbPuppet] = await Promise.all([poseOf(b), puppetOf(a, idB)]);
  assert.ok(pbPuppet, 'A must still mirror a puppet for B');
  const errB = dist(pbReal, pbPuppet);
  ctx.log(`puppet-of-B on A (stationary): error ${errB.toFixed(1)} units`);
  assert.ok(errB < CONVERGE_EPS, `stationary puppet drifted: ${errB.toFixed(1)} units`);
}
