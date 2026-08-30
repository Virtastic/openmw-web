// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s22 (M2): death -> respawn. A walks off the spawn point and dies (sethp:0); the death
// edge sends PlayerStatsDynamic+PlayerDeath, the server's respawn plugin answers
// PlayerResurrect, and the client must teleport back to the configured respawn point
// (the harness config pins it to the ?start=Village drop: 26,25 @ 216831,204909,513),
// revive (mp.resurrect binding) and refill dynamic stats.
import assert from 'node:assert/strict';

const RESPAWN = { x: 216831, y: 204909, z: 513 }; // must match mp-harness config.toml [rules]
const RESPAWN_EPS = 128;
const RESPAWN_TIMEOUT = 15_000;

const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

export default async function run(ctx) {
  const a = await ctx.launchClient('bot-a');

  // Move away so the respawn teleport is observable.
  await a.eval(`Module.__omwMPCmd='walk:0,1,2500'`);
  // WAIT FOR THE WALK, do not assume it fits in a fixed sleep. This was sleep(3500) and it made
  // the scenario fail on a build where walking works: the pose the test reads is a 2Hz mirror
  // (POSE_MIRROR_INTERVAL in scripts/mp/player.lua), so under software GL on a loaded box the
  // reading can still be the starting point when the timer expires. Same fault as s45's invite
  // teleport, which looked like a broken feature and was a deadline.
  await a.waitFor(
    `(() => { try { const p = JSON.parse((window.__omwMP||{}).pose);
       return Math.hypot(p.x-${RESPAWN.x}, p.y-${RESPAWN.y}, p.z-${RESPAWN.z}) > 250;
     } catch (e) { return false; } })()`,
    30_000, 'A walked away from the respawn point');
  const before = JSON.parse(await a.eval('(window.__omwMP||{}).pose||"null"'));
  assert.ok(before && dist(before, RESPAWN) > 250, 'A must be away from the respawn point');

  // Die. Death edge -> PlayerDeath -> server respawn plugin -> PlayerResurrect.
  await a.eval(`Module.__omwMPCmd='sethp:0'`);

  const deadline = Date.now() + RESPAWN_TIMEOUT;
  let pose = null;
  let err = Infinity;
  while (Date.now() < deadline) {
    pose = JSON.parse(await a.eval('(window.__omwMP||{}).pose||"null"'));
    if (pose) {
      err = dist(pose, RESPAWN);
      if (err < RESPAWN_EPS) break;
    }
    await ctx.sleep(500);
  }
  ctx.log(`respawn teleport error ${err.toFixed(1)} units`);
  assert.ok(err < RESPAWN_EPS, `not respawned at the configured point: ${err.toFixed(1)} units off`);

  // Revived with restored hp (restoreHp=true in the plugin), session still Joined.
  await a.waitFor('Number((window.__omwMP||{}).hp||"0") > 0', 8000, 'hp restored after respawn');
  const state = await a.eval('(window.__omwMP||{}).state');
  assert.equal(state, 'Joined', 'session must survive death/respawn');
  ctx.log('ok: death -> respawn teleport + revive + refill');
}
