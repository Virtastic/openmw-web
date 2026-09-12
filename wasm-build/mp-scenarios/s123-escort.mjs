// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s123: AN ESCORT LEADS THE WAY, ON EVERY SCREEN. An escort quest ("AIEscort player 0 x y z"
// from a dialogue result) is the NPC WALKING TO A DESTINATION with the player in tow -- the
// pilgrim, the prisoner, the scared merchant. It runs on the talking player's client, whose
// copy has its AI off, so companion.lua reports Escort with its destination, the claim
// carries the destination, the holder starts Escort on ITS NPC, and the poses reach the
// other player. s114 proved Follow; this is the other package the same chain carries.
import assert from 'node:assert/strict';

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const probeOf = async (c) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'));
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const DEST = { x: -12288, y: -69632, z: 87 }; // the spawn point: known dry land

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  for (const c of [a, b]) await c.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 300_000, `${c.name} puppeted the cell actors`);
  const [pa, pb] = await Promise.all([probeOf(a), probeOf(b)]);
  // Somebody standing well away from the destination, so the walk is measurable.
  const rec = Object.keys(pa).find((r) => r !== 'player' && pb[r] && !pa[r].dead && !pa[r].guard
    && !/mudcrab|scrib|rat|slaughterfish|kwama|cliff/.test(r) && dist2(pa[r], DEST) > 800);
  assert.ok(rec, 'need a living NPC visible to both, standing away from the spawn');
  const start = pa[rec];
  await a.cmd(`snapto:${Math.round(start.x + 80)},${Math.round(start.y)},${Math.round(start.z + 8)}`);
  await ctx.sleep(4_000);
  await a.cmd(`escort:${rec}:${DEST.x},${DEST.y},${DEST.z}`);
  await ctx.sleep(3_000);
  ctx.log(`A asked "${rec}" to escort them to the spawn (claim=${await a.eval('window.omw.state.followClaim')}, report=${await a.eval('window.omw.state.companionReport')}); ${Math.round(dist2(start, DEST))} units to go`);

  // A tags along (an escort waits for its charge); B watches from the spawn.
  const deadline = Date.now() + 120_000;
  let dB = Infinity, dA = Infinity;
  while (Date.now() < deadline) {
    const qa = await probeOf(a);
    if (qa[rec]) { dA = dist2(qa[rec], DEST); await a.cmd(`snapto:${Math.round(qa[rec].x + 60)},${Math.round(qa[rec].y)},${Math.round(qa[rec].z + 8)}`); }
    const qb = await probeOf(b);
    if (qb[rec]) dB = dist2(qb[rec], DEST);
    if (dB < 400 && dA < 400) break;
    await ctx.sleep(2_000);
  }
  ctx.log(`escort distance to the destination: on A ${Math.round(dA)}, on B ${Math.round(dB)}`);
  assert.ok(dB < 400, `B never saw "${rec}" walk to the destination (${Math.round(dB)} units away): the escort claim did not start the package on the holder`);
  ctx.log(`ok: "${rec}" escorted A to the spawn, and B saw it walk there`);
}
