// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s10 (M1): movement + puppets. Both clients spawn in Village, so each must get a puppet of
// the other (server force-includes poses on visibility). Then A walks forward via the harness
// 'walk' injection; B's puppet-of-A must track and converge on A's real pose.
//
// Mirrors used (2 Hz each): __omwMP.pose = own {x,y,z} (player.lua), __omwMP.puppets =
// {"<id>":{x,y,z}} of the puppet OBJECT positions (global.lua).
import assert from 'node:assert/strict';

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

  const idA = await a.eval('(window.__omwMP||{}).playerId');
  const idB = await b.eval('(window.__omwMP||{}).playerId');
  assert.ok(idA && idB, 'both clients must have playerIds');

  // Same cell -> mutual visibility -> each spawns a puppet of the other.
  const puppetExpr = (id) => `!!(JSON.parse((window.__omwMP||{}).puppets||"{}")[${JSON.stringify(id)}])`;
  await a.waitFor(puppetExpr(idB), PUPPET_SPAWN_TIMEOUT, `puppet of ${b.name} on A`);
  await b.waitFor(puppetExpr(idA), PUPPET_SPAWN_TIMEOUT, `puppet of ${a.name} on B`);
  ctx.log('ok: both puppets spawned');

  const poseOf = async (c) => JSON.parse(await c.eval('(window.__omwMP||{}).pose||"null"'));
  const puppetOf = async (c, id) => JSON.parse(await c.eval('(window.__omwMP||{}).puppets||"{}"'))[id] || null;

  const startPose = await poseOf(a);
  assert.ok(startPose, 'A must mirror its own pose');

  // Drive A forward (walk injection overrides the omw input controls for the duration).
  await a.eval(`Module.__omwMPCmd='walk:0,1,${WALK_MS}'`);
  await ctx.sleep(WALK_MS + 500);
  const endPose = await poseOf(a);
  const walked = dist(startPose, endPose);
  ctx.log(`A walked ${walked.toFixed(1)} units`);
  assert.ok(walked > 100, `walk injection barely moved A (${walked.toFixed(1)} units)`);

  // B's puppet-of-A must converge on A's real pose (both mirrors are 2 Hz, so give slack).
  const deadline = Date.now() + CONVERGE_TIMEOUT;
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
  ctx.log(`puppet-of-A on B: final error ${err.toFixed(1)} units (best ${best.toFixed(1)})`);
  assert.ok(err < CONVERGE_EPS,
    `puppet did not converge: ${err.toFixed(1)} units (eps ${CONVERGE_EPS})`);

  // And the reverse direction: B stands still, A's puppet-of-B must sit near B's pose.
  const [pbReal, pbPuppet] = await Promise.all([poseOf(b), puppetOf(a, idB)]);
  assert.ok(pbPuppet, 'A must still mirror a puppet for B');
  const errB = dist(pbReal, pbPuppet);
  ctx.log(`puppet-of-B on A (stationary): error ${errB.toFixed(1)} units`);
  assert.ok(errB < CONVERGE_EPS, `stationary puppet drifted: ${errB.toFixed(1)} units`);
}
