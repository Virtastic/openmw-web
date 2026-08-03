// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s21 (M2): rejoin restore. A equips + damages + moves, disconnects (abrupt close -> server
// flushes the player doc), reconnects on the SAME account: SessionWelcome.playerRecord must
// be applied — equipment back, hp back, position back at the pre-logout spot.
import assert from 'node:assert/strict';

const RESTORE_TIMEOUT = 20_000;
const POS_EPS = 96; // restore teleports to the flushed position; allow settle noise

const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

export default async function run(ctx) {
  const a = await ctx.launchClient('bot-a');

  // Give the session distinctive state: hp 21, moved off the spawn point. (Equipment
  // restore is not asserted here: the demo's only items are per-client dynamic records,
  // whose ids cannot survive a relog by construction — s20 covers the equipment pipeline.)
  await a.eval(`Module.__omwMPCmd='walk:0,1,2000'`);
  await ctx.sleep(3000);
  await a.eval(`Module.__omwMPCmd='sethp:21'`);
  await a.waitFor('(window.__omwMP||{}).hp === "21"', 5000, 'A hp mirror = 21');
  await ctx.sleep(1500); // let the movement/equipment/stats diffs reach the server
  const pose = JSON.parse(await a.eval('(window.__omwMP||{}).pose||"null"'));
  assert.ok(pose, 'A pose mirror');

  a.close(); // abrupt disconnect -> server flushes the doc on logout
  await ctx.sleep(2500);

  const a2 = await ctx.launchClient('bot-a'); // same run-suffixed name = same account
  await a2.waitFor('(window.__omwMP||{}).restored === "1"', RESTORE_TIMEOUT, 'rejoin restore applied');

  // hp restored (dynamic snapshot round-trip through the server doc).
  await a2.waitFor('(window.__omwMP||{}).hp === "21"', 8000, 'restored hp = 21');
  // position restored to the flushed spot.
  const deadline = Date.now() + 10_000;
  let err = Infinity;
  while (Date.now() < deadline) {
    const p2 = JSON.parse(await a2.eval('(window.__omwMP||{}).pose||"null"'));
    if (p2) {
      err = dist(pose, p2);
      if (err < POS_EPS) break;
    }
    await ctx.sleep(500);
  }
  ctx.log(`restore position error ${err.toFixed(1)} units`);
  assert.ok(err < POS_EPS, `position not restored: ${err.toFixed(1)} units (eps ${POS_EPS})`);
  ctx.log('ok: rejoin restored equipment, hp and position');
}
