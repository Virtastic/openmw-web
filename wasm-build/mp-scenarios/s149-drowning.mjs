// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s149: YOU CAN DROWN, ONCE. Under water past the breath timer the game hurts you; the peer
// rules the body, and its avatar is under the same water. The player must lose health (a
// helper who could not drown could scout the sea bed for free) and lose it ONCE -- a local
// drowning tick plus the avatar's would kill twice as fast. Then surfacing must stop it.
// Deep water is needed: at the s109 spot the sea is 133 units deep and a swimmer's head
// bobs at the surface (measured: 60 s there cost nothing, correctly). Cell -3,-9, west of
// Seyda Neen, has a sea floor 1136 units down (Morrowind.esm LAND/VHGT); a body 400 down
// there is well under, and sneak (swim down) holds it there.
import assert from 'node:assert/strict';

// THE SERVER'S OWN PEER, anchored on the players: a hand-started peer processes actors only
// within range of its parked avatar, and this spot is out of that range -- the avatar sat
// out of processing range and never drowned, never fell (the s149 probe: inRange=false).
export const managedPeer = true;

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const SEABED = { x: -19264, y: -72128, z: -400 }; // -3,-9: the floor is at -1136
// The breath clock runs on the engine's clamped frame time: a headless harness client at
// ~1 fps counts 20 s of breath in over two real minutes (measured 0.15 s/s). Hold until the
// ENGINE says the breath is gone, then a little longer for the damage to show.
const HOLD_S = 240;

const parseBars = (s) => { const m = /^(\d+)\/(\d+)$/.exec(String(s ?? '')); return m ? { c: Number(m[1]), b: Number(m[2]) } : null; };
const bars = async (c) => parseBars(await c.eval('window.omw.state.selfStats'));
const pose = async (c) => JSON.parse(await c.eval('window.omw.state.pose||"null"'));

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-3,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  await a.waitFor('String(window.omw.state.baselineReady||"") === "1"', 120_000, 'the character is settled (the join-time restore is done)');
  // ON DRY LAND FIRST. The dive used to come before the health setup, and the setup's waits
  // (the max rose, the pool filled, B's puppet) ran 30-60 s while A already sat on the seabed:
  // the avatar's 20 s of breath was gone before the timed hold began, so it drowned from t+0
  // and 'hurt before the breath ran out' failed every sweep (the peer's own probe: 'submerged:
  // breath=0' at the first sample). The clock starts when A goes under, so A goes under last.
  await a.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 120_000, 'the cell is peer-held');
  await a.waitFor('String(window.omw.state.selfStats||"").indexOf("/") > 0', STEP, 'the peer reports the bars');
  const idA = await a.eval('window.omw.state.playerId');
  const rowOf = `(JSON.parse(window.omw.state.puppets||"{}")[${JSON.stringify(String(idA))}]||{})`;
  await b.waitFor(`${rowOf}.x !== undefined`, STEP, 'B has a puppet of A');
  await ctx.sleep(3_000);
  // A bigger pool first (s144's honest way, then a claimed gain): 20 s of breath and then
  // three health a second would kill a 35-health character inside the sampling window.
  const s0 = await bars(a);
  await a.cmd(`sethpbase:${s0.b + 60}`);
  await a.waitFor(`Number(String(window.omw.state.selfStats||"0/0").split("/")[1]) >= ${s0.b + 58}`, STEP, 'the max rose');
  await a.cmd(`sethp:${s0.b + 60}`);
  await a.waitFor(`Number(String(window.omw.state.selfStats||"0/0").split("/")[0]) >= ${s0.b + 50}`, STEP, 'the pool filled');
  // B GOES FIRST, AND CLEARS THE WATER. B stands at the surface of the sea spot (a vertical
  // teleport off the seabed: left down there B drowned too, #131) and kills the cell's
  // slaughterfish through the test hook before A dives -- a bite is what read as 'hurt before
  // the breath ran out' whenever one wandered by (#132; the two builder runs had none near).
  // Only a client in the cell can name its actors, and A is still on dry land.
  // B GETS THE SAME BIGGER POOL: it kills from the seabed (the only spot a snap lands on in
  // that cell), and a vertical teleport up dropped it back in with fall momentum, sinking with
  // no swim-up input until it drowned and respawned in the village (#134: B in another cell,
  // 'B's puppet of A' gone). At 95 hp the seabed is survivable for the half minute the kills
  // take on a slow client; then straight back to land.
  { const b0 = await bars(b);
    await b.cmd(`sethpbase:${b0.b + 60}`);
    await b.waitFor(`Number(String(window.omw.state.selfStats||"0/0").split("/")[1]) >= ${b0.b + 58}`, STEP, "B's max rose");
    await b.cmd(`sethp:${b0.b + 60}`);
    await b.waitFor(`Number(String(window.omw.state.selfStats||"0/0").split("/")[0]) >= ${b0.b + 50}`, STEP, "B's pool filled"); }
  await b.cmd(`snapto:${SEABED.x + 300},${SEABED.y},${SEABED.z}`);
  await b.waitFor('JSON.parse(window.omw.state.pose||"{}").z < -250', STEP, 'B is at the sea spot');
  for (let i = 0; i < 4; i++) { await b.cmd('killnpc:slaughterfish'); await b.cmd('killnpc:slaughterfish_small'); await ctx.sleep(500); }
  await b.cmd('snapto:-12288,-69632,87'); // back onto land (the retail start), as A does after the hold
  await b.waitFor('JSON.parse(window.omw.state.pose||"{}").z > 0', STEP, 'B is back on land');
  await ctx.sleep(4_000); // the deaths travel client -> server -> peer
  const start = await bars(a);
  await a.cmd(`snapto:${SEABED.x},${SEABED.y},${SEABED.z}`);
  const t0 = Date.now(); // the breath clock: A went under now
  await a.waitFor('JSON.parse(window.omw.state.pose||"{}").z < -250', STEP, 'A is deep under');
  const at = await pose(a);
  ctx.log(`A under water at z=${at.z.toFixed(0)} with ${start.c}/${start.b}`);
  assert.ok(at.z < -250, `A is not deep under (z=${at.z.toFixed(0)})`);
  await b.waitFor(`${rowOf}.z < -250`, STEP, "B's puppet of A is under water too");
  // Hold the depth: sneak is swim-down.
  await a.cmd(`walk:0,0,${HOLD_S * 1000}:sneak`);

  // Hold there. Sample the peer's bars and the client's own bar every 5 s.
  let cur = start, local = start.c, firstHurtAt = 0;
  while (Date.now() - t0 < HOLD_S * 1000) {
    await ctx.sleep(2_000);
    cur = (await bars(a)) || cur;
    local = Number(await a.eval('window.omw.state.hp'));
    if (!firstHurtAt && cur.c < start.c - 1) firstHurtAt = Date.now() - t0;
    if (true) {
      const z = (await pose(a)).z, az = Number(JSON.parse(await b.eval(`JSON.stringify(${rowOf})`)).z);
      await a.eval("if (window.omw.state) window.omw.state.body = null; 'cleared';"); await a.cmd('body');
      await a.waitFor("typeof window.omw.state.body === 'string'", 5_000, 'body answered');
      ctx.log(`t+${Math.round((Date.now() - t0) / 1000)}s peer ${cur.c}/${cur.b} client ${local}; A at z=${z.toFixed(0)}, avatar (as B sees it) z=${az.toFixed(0)}; engine says ${await a.eval('window.omw.state.body')}`);
    }
    if (cur.c <= 25 || local <= 25) break; // never let the bot die; that is s22/s77's business
    if (firstHurtAt) { await ctx.sleep(4_000); cur = (await bars(a)) || cur; local = Number(await a.eval('window.omw.state.hp')); break; }
  }
  assert.ok(cur.c < start.c - 1, `${HOLD_S} s under water cost nothing (${start.c} -> ${cur.c}): drowning never reached the ruling body`);
  assert.ok(cur.c > 0, 'the bot must not die here');
  // ONLY DROWNING COUNTS: fHoldBreathTime is 20 s, so a loss inside the first 15 s is a
  // slaughterfish, a fall on the snap, anything but the water (the s999 control's check).
  assert.ok(firstHurtAt >= 15_000, `hurt at t+${Math.round(firstHurtAt / 1000)}s, before the breath ran out -- that was not drowning`);
  const lost = start.c - cur.c;
  assert.ok(Math.abs(local - cur.c) <= Math.max(3, lost * 0.5),
    `client ${local} vs peer ${cur.c} (lost ${lost}): one side drowned twice`);

  // Surface: lift A out of the water; the bleeding must stop.
  await a.cmd('walk:0,0,1:sneak'); // stop diving
  // ONTO LAND, not just up: snapto lands ON the ground (482) and the ground here is the seabed
  // (#131: 'surfaced' left A where it was, 56 -> 0, dead); a vertical teleport dropped A into
  // the water with fall momentum and it sank to -132 with no swim-up input (two builder runs).
  // The retail start is dry land two cells over: one snap, the avatar follows across the
  // border in one hop, and both stand with their heads in the air.
  await a.cmd('snapto:-12288,-69632,87');
  await a.waitFor('JSON.parse(window.omw.state.pose||"{}").z > 0', STEP, 'A is on land');
  await ctx.sleep(3_000);
  const surfaced = (await bars(a)) || cur;
  await ctx.sleep(15_000);
  const later = (await bars(a)) || surfaced;
  ctx.log(`surfaced: ${surfaced.c} then ${later.c} fifteen seconds later`);
  assert.ok(later.c >= surfaced.c - 1, `still losing health out of the water (${surfaced.c} -> ${later.c})`);
  ctx.log(`PASS: drowning cost ${lost} health once (first hit at t+${Math.round(firstHurtAt / 1000)}s), both sides agree, and it stopped on surfacing`);
}
