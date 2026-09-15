// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s22 (M2): death -> respawn. A DROWNS (a real cause, on the peer-ruled body: the avatar's
// breath runs out on the peer, its bars hit zero, the owner is killed by the report); the
// death edge sends PlayerStatsDynamic+PlayerDeath, the server's respawn plugin answers
// PlayerResurrect, and the client must teleport back to the configured respawn point
// (the harness config pins it to 26,25 @ 216831,204909,513), revive (mp.resurrect binding)
// and refill dynamic stats. Used to die by sethp:0 -- a client claim -- so death FROM DAMAGE
// was never exercised (backlog 241).
import assert from 'node:assert/strict';
import { drown } from './_death.mjs';

export const managedPeer = true; // the peer must rule the body for the drowning to be its verdict
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const RESPAWN = { x: 216831, y: 204909, z: 513 }; // must match mp-harness config.toml [rules]
const RESPAWN_EPS = 128;
const DROWN_TIMEOUT = 300_000; // 20 s of breath, then ~3 hp/s, on the peer's clock

const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

export default async function run(ctx) {
  const a = await ctx.launchClient('bot-a', '', BOOT);
  await a.waitFor('String(window.omw.state.baselineReady||"") === "1"', 120_000, 'the character is settled');
  await a.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 120_000, 'the cell is peer-held');
  await a.waitFor('String(window.omw.state.selfStats||"").indexOf("/") > 0', 30_000, 'the peer reports the bars');

  await drown(a, ctx);
  const before = JSON.parse(await a.eval('window.omw.state.pose||"null"'));
  assert.ok(before && dist(before, RESPAWN) > 250, 'A must be away from the respawn point');

  // Death edge -> PlayerDeath -> server respawn plugin -> PlayerResurrect: the teleport is
  // the observable, and the server's own log line is the proof a death went through it.
  const deadline = Date.now() + DROWN_TIMEOUT;
  let pose = null, err = Infinity, lastSaid = 0;
  while (Date.now() < deadline) {
    pose = JSON.parse(await a.eval('window.omw.state.pose||"null"'));
    if (pose) { err = dist(pose, RESPAWN); if (err < RESPAWN_EPS) break; }
    if (Date.now() - lastSaid > 20_000) {
      lastSaid = Date.now();
      ctx.log(`waiting to drown: peer ${await a.eval('window.omw.state.selfStats')} client hp ${await a.eval('window.omw.state.hp')} z=${pose ? pose.z.toFixed(0) : '?'}`);
    }
    await ctx.sleep(500);
  }
  ctx.log(`respawn teleport error ${err.toFixed(1)} units`);
  assert.ok(err < RESPAWN_EPS, `not respawned at the configured point within ${DROWN_TIMEOUT / 1000} s: ${err.toFixed(1)} units off (never drowned, or never resurrected)`);
  assert.ok(/respawn\.sent/.test(ctx.serverLogTail(2000)), 'the server never logged respawn.sent: the teleport did not come from a death');

  // Revived with restored hp (restoreHp=true in the plugin), session still Joined.
  await a.waitFor('Number(window.omw.state.hp||"0") > 0', 8000, 'hp restored after respawn');
  const state = await a.eval('window.omw.state.state');
  assert.equal(state, 'Joined', 'session must survive death/respawn');
  ctx.log('ok: drowned -> respawn teleport + revive + refill');
}
