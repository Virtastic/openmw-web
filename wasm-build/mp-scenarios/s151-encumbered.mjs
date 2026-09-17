// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s151: OVER-ENCUMBERED, YOU CANNOT MOVE -- on every screen. Carrying capacity is a rule the
// player's own engine applies to its predicted movement and the peer applies to the avatar
// that rules the body. If only one of them knew about the weight, the player would either
// walk on their own screen and be dragged back (a rubber-band that looks like lag), or stand
// still while their avatar strolls off. Load the pack past capacity, try to walk, and
// expect no ground covered on the owner's screen or the friend's; then drop the load and
// walk.
import assert from 'node:assert/strict';

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const HEAVY = 'iron_cuirass'; // 30 weight each in retail ('iron cuirass' is the display name)
const N = 12; // 360 units of weight: past any level-1 character's capacity (5 x Strength)

const pose = async (c) => JSON.parse(await c.eval('window.omw.state.pose||"null"'));
const dist2 = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
async function countOf(c, id) {
  await c.eval("if (window.omw.state) window.omw.state.count = null; 'cleared';");
  await c.cmd(`count:${id}`);
  await c.waitFor("typeof window.omw.state.count === 'string'", 10_000, `count of ${id} answered`);
  return Number(await c.eval('window.omw.state.count'));
}

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  await a.waitFor('String(window.omw.state.baselineReady||"") === "1"', 120_000, 'the character is settled (the join-time restore is done)');
  await a.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 120_000, 'the cell is peer-held');
  const idA = await a.eval('window.omw.state.playerId');
  const rowOf = `(JSON.parse(window.omw.state.puppets||"{}")[${JSON.stringify(String(idA))}]||{})`;
  await b.waitFor(`${rowOf}.x !== undefined`, STEP, 'B has a puppet of A');
  await ctx.sleep(3_000);

  // Control: unburdened, a 3 s walk covers ground. The start faces the Census office wall,
  // so find an open direction first (forward, back, left, right) and keep it.
  // Two spots, in case the first is boxed in: the cell centre, then the road west of the
  // Census office. Every probe also logs the divergence from the avatar: a walk that is
  // short WITH a large divergence is the peer dragging the player back, not a wall.
  let dir = null, free = 0;
  // The cell centre is a terrain pit (measured: every direction 20-44 units, z falling);
  // the road west of the Census office walks.
  for (const spot of [{ x: -11400, y: -70000, z: 200 }, { x: -11000, y: -70400, z: 200 }]) {
    if (spot) { await a.cmd(`snapto:${spot.x},${spot.y},${spot.z}`); await ctx.sleep(4_000); }
    for (const [dx, dy, name] of [[0, 1, 'forward'], [0, -1, 'back'], [-1, 0, 'left'], [1, 0, 'right']]) {
      const p0 = await pose(a);
      await a.cmd(`walk:${dx},${dy},3000`);
      await ctx.sleep(1_500);
      const midDiv = Number(await a.eval('window.omw.state.selfDivergence||0'));
      await ctx.sleep(2_500);
      const d = dist2(p0, await pose(a));
      ctx.log(`unburdened walk ${name} covered ${d.toFixed(0)} units (divergence mid-walk ${midDiv.toFixed(0)}) at ${JSON.stringify(p0)}`);
      if (d > 100) { dir = `${dx},${dy}`; free = d; break; }
    }
    if (dir) break;
  }
  assert.ok(dir, 'no direction moved more than 100 units at either spot (the walk hook is broken, the peer drags the player back, or A is boxed in)');

  // The load.
  for (let i = 0; i < N; i++) { await a.cmd(`give:${HEAVY}`); await ctx.sleep(120); }
  await a.waitFor('true', 500, 'granted');
  const n = await countOf(a, HEAVY);
  assert.equal(n, N, `expected ${N} cuirasses in the pack, found ${n}`);
  // Let the inventory doc reach the peer (the avatar must be as heavy as we are).
  await ctx.sleep(4_000);
  const p2 = await pose(a);
  const q2 = JSON.parse(await b.eval(`JSON.stringify(${rowOf})`));
  await a.cmd(`walk:${dir},3000`);
  // WHO MOVED A. The local engine refuses to walk an over-encumbered body (Npc::getSpeed is 0
  // past capacity), so ground covered on A's own screen is a correction or a snap toward an
  // avatar that is not where A is -- #111 measured 80 u with the avatar standing still on B's
  // screen and a 63 u divergence, which no walk explains. Sample both sides through the walk.
  for (let i = 0; i < 4; i++) {
    await ctx.sleep(1_000);
    const pa = await pose(a), qa = JSON.parse(await b.eval(`JSON.stringify(${rowOf})`));
    ctx.log(`  t+${i + 1}s A own (${pa.x.toFixed(0)},${pa.y.toFixed(0)}) avatar on B (${Number(qa.x).toFixed(0)},${Number(qa.y).toFixed(0)})`
      + ` divergence ${await a.eval('window.omw.state.selfDivergence||"?"')} snap=${await a.eval('window.omw.state.selfSnap||""')} stale=${await a.eval('window.omw.state.selfStale||""')}`);
  }
  const p3 = await pose(a);
  const q3 = JSON.parse(await b.eval(`JSON.stringify(${rowOf})`));
  const own = dist2(p2, p3), seen = dist2(q2, q3);
  const div = Number(await a.eval('window.omw.state.selfDivergence||0'));
  ctx.log(`over-encumbered walk: own screen ${own.toFixed(0)} units, on B's screen ${seen.toFixed(0)} units, divergence ${div.toFixed(0)}`);
  assert.ok(own < 40, `A walked ${own.toFixed(0)} units while over-encumbered on their own screen`);
  assert.ok(seen < 60, `B saw A cover ${seen.toFixed(0)} units while over-encumbered`);
  assert.ok(div < 100, `A and the avatar disagree by ${div.toFixed(0)} units: only one side applied the weight`);

  // Drop the load; walking works again.
  for (let i = 0; i < N; i++) { await a.cmd(`drop:${HEAVY}`); await ctx.sleep(150); }
  await ctx.sleep(4_000);
  const left = await countOf(a, HEAVY);
  ctx.log(`dropped the cuirasses (${left} left in the pack)`);
  // The avatar sheds the load when the inventory diff (2 s cadence) reaches the peer and
  // the doc is pushed; try a few walks over ~20 s rather than one guess at the latency.
  let again = 0;
  for (let i = 0; i < 5 && again < 100; i++) {
    const p4 = await pose(a);
    await a.cmd(`walk:${dir},3000`);
    await ctx.sleep(3_500);
    again = dist2(p4, await pose(a));
    ctx.log(`after dropping the load, walk ${i + 1} covered ${again.toFixed(0)} units (divergence ${await a.eval('window.omw.state.selfDivergence')})`);
  }
  assert.ok(left === 0, `the drops did not empty the pack (${left} left)`);
  assert.ok(again > 100, `still cannot move after dropping the load (${again.toFixed(0)} units): the avatar kept the weight`);
  ctx.log('PASS: over-encumbered on every screen, mobile again once the load is dropped');
}
