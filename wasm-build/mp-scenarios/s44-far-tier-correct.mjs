// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s44 (Phase G): FAR-TIER CORRECTNESS. The render-LOD win is large — a far-tier avatar
// costs ~0.06ms of frame time against ~1.22ms for a fully simulated one — and it is bought
// by not driving the character controller at all. That makes it a cheat unless the avatar
// still ends up in the RIGHT PLACE: an optimisation that lets remote players drift is not a
// cheaper renderer, it is a broken one, and every capacity number resting on it is void.
//
// Same shape as s10 (which covers the near-tier default), but with lodRadius = 0 so both
// clients see each other as FAR. The tolerance is looser on purpose — far tier repositions
// on a wide threshold instead of walking, so the puppet is expected to lag and then jump —
// but it is a FIXED bound, not "whatever it happened to do".
import assert from 'node:assert/strict';

const PUPPET_SPAWN_TIMEOUT = 15_000;
// Long enough to carry A well past the far tier's 1024-unit reposition threshold. A shorter
// walk lets the puppet pass by never moving at all — the error stays under the threshold, so
// a completely broken reposition path scores the same as a working one.
const WALK_MS = 16000;
const CONVERGE_TIMEOUT = 20_000;
// puppet.lua SNAP_BY_TIER far = 2048 units, plus interpolation delay and the 2 Hz mirrors.
// Beyond this the avatar is not "degraded", it is lost. Wide because repositioning is the
// expensive operation for a degraded avatar (see puppet.lua) — this bound is the cost of
// the win, and it is stated explicitly rather than discovered in play.
const FAR_EPS = 2600;

// Force every avatar into the far tier regardless of where the two clients stand, and hold
// the send rate at the normal 15 Hz so this measures the RENDER path rather than accidental
// starvation of pose updates.
export const serverRules =
  '\n[limits]\nrenderLod = "tiered"\nlodNearRadius = 0\nlodMidRadius = 0\n'
  + 'lodNearHz = 15\nlodMidHz = 15\nlodFarHz = 15\n';

const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

export default async function run(ctx) {
  const [a, b] = await Promise.all([
    ctx.launchClient('far-a'),
    ctx.launchClient('far-b'),
  ]);

  const idA = await a.eval('(window.__omwMP||{}).playerId');
  const idB = await b.eval('(window.__omwMP||{}).playerId');
  assert.ok(idA && idB, 'both clients must have playerIds');

  const puppetExpr = (id) => `!!(JSON.parse((window.__omwMP||{}).puppets||"{}")[${JSON.stringify(id)}])`;
  await a.waitFor(puppetExpr(idB), PUPPET_SPAWN_TIMEOUT, `puppet of ${b.name} on A`);
  await b.waitFor(puppetExpr(idA), PUPPET_SPAWN_TIMEOUT, `puppet of ${a.name} on B`);

  ctx.log('ok: both puppets spawned');
  // The tier check deliberately waits until AFTER the walk below. Both clients spawn on the
  // same Village point, so before anyone moves their separation is exactly zero — and with
  // lodNearRadius = 0 that is `d2 <= 0`, i.e. genuinely NEAR. Asserting the far tier here
  // would be asserting against coincident players and would fail on correct behaviour.

  const poseOf = async (c) => JSON.parse(await c.eval('(window.__omwMP||{}).pose||"null"'));
  const puppetOf = async (c, id) => JSON.parse(await c.eval('(window.__omwMP||{}).puppets||"{}"'))[id] || null;

  const startPose = await poseOf(a);
  assert.ok(startPose, 'A must mirror its own pose');
  const puppetBefore = await puppetOf(b, idA);
  assert.ok(puppetBefore, 'B must mirror a puppet for A before the walk');

  await a.eval(`Module.__omwMPCmd='walk:0,1,${WALK_MS}'`);
  await ctx.sleep(WALK_MS + 500);
  const endPose = await poseOf(a);
  const walked = dist(startPose, endPose);
  ctx.log(`A walked ${walked.toFixed(1)} units`);
  // Must exceed the far reposition threshold, or the check below proves nothing.
  assert.ok(walked > 2400,
    `A must walk past the far-tier reposition threshold for this test to mean anything, got ${walked.toFixed(1)} units`);

  // Now that they are apart, everyone must actually BE degraded — otherwise this scenario
  // passes by exercising the near path twice and the far tier ships unverified.
  await b.waitFor('JSON.parse((window.__omwMP||{}).puppetTiers||"{}").far > 0',
    PUPPET_SPAWN_TIMEOUT, 'B classified its avatars as FAR tier');
  const tiers = JSON.parse(await b.eval('(window.__omwMP||{}).puppetTiers||"{}"'));
  assert.ok(!tiers.near, `expected nobody in the near tier, got ${JSON.stringify(tiers)}`);
  ctx.log(`tiers on B: ${JSON.stringify(tiers)}`);

  const deadline = Date.now() + CONVERGE_TIMEOUT;
  let err = Infinity;
  let best = Infinity;
  while (Date.now() < deadline) {
    const [pa, pb] = await Promise.all([poseOf(a), puppetOf(b, idA)]);
    if (pa && pb) {
      err = dist(pa, pb);
      best = Math.min(best, err);
      if (err < FAR_EPS) break;
    }
    await ctx.sleep(400);
  }
  ctx.log(`far-tier puppet-of-A on B: final error ${err.toFixed(1)} units (best ${best.toFixed(1)}, eps ${FAR_EPS})`);
  assert.ok(err < FAR_EPS,
    `far-tier puppet did not track its player: ${err.toFixed(1)} units — degraded avatars must still be in the right place`);
  // The puppet must have MOVED, not merely ended up within tolerance. Distance-to-target
  // alone would be satisfied by a puppet frozen where it spawned if the player happened to
  // stop nearby, which is precisely the bug this scenario exists to catch.
  const puppetAfter = await puppetOf(b, idA);
  const puppetMoved = dist(puppetBefore, puppetAfter);
  ctx.log(`far-tier puppet repositioned by ${puppetMoved.toFixed(1)} units`);
  assert.ok(puppetMoved > 500,
    `far-tier puppet never repositioned (moved ${puppetMoved.toFixed(1)} units while its player walked ${walked.toFixed(1)})`);

  // A stationary far avatar must not wander. Driving controls is what normally holds an
  // actor in place, and the far tier stops doing it, so "does it drift when left alone" is
  // a genuinely different question from the tracking case above.
  const [pbReal, pbPuppet] = await Promise.all([poseOf(b), puppetOf(a, idB)]);
  assert.ok(pbPuppet, 'A must still mirror a puppet for B');
  const errB = dist(pbReal, pbPuppet);
  ctx.log(`far-tier stationary puppet-of-B on A: error ${errB.toFixed(1)} units`);
  assert.ok(errB < FAR_EPS, `stationary far-tier puppet drifted: ${errB.toFixed(1)} units`);
}
