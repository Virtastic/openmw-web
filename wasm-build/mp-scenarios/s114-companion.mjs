// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s114: A COMPANION FOLLOWS YOU, ON EVERYONE'S SCREEN. Recruiting is a dialogue result that
// runs on the recruiting player's own client, whose copy of the NPC is a puppet with its AI
// off. So the fact is born on a non-holder: companion.lua on that puppet notices the Follow
// package, the client claims "this one follows ME" (ActorAI; the server admits it from the
// player who holds the NPC's dialogue lock), the holder starts the package on ITS NPC, and
// the pose stream carries the companion to every other screen. Several main-quest arcs hand
// you a companion; before this chain existed the follower moved for the recruiter alone.
//
// Live proof: A talks to an NPC, recruits it, walks off; B -- who did nothing -- sees the NPC
// arrive next to A.
import assert from 'node:assert/strict';

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const probeOf = async (c) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'));
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  for (const c of [a, b]) {
    await c.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 300_000, `${c.name} puppeted the cell actors (the peer holds it)`);
  }
  // A living NPC both see, that is not a guard (guards have their own ideas).
  const [pa, pb] = await Promise.all([probeOf(a), probeOf(b)]);
  const rec = Object.keys(pa).find((r) => r !== 'player' && pb[r] && !pa[r].dead && !pa[r].guard);
  assert.ok(rec, 'need a living NPC visible to both clients');
  const start = pa[rec];
  ctx.log(`A recruits "${rec}" at (${Math.round(start.x)},${Math.round(start.y)})`);

  // Stand beside them first: you recruit by talking, and AiFollow activates only with the
  // target in range and in sight (mwmechanics/aifollow.cpp), on the peer where the avatar is.
  await a.cmd(`snapto:${Math.round(start.x + 80)},${Math.round(start.y)},${Math.round(start.z + 8)}`);
  await ctx.sleep(4_000);

  // Recruit: the dialogue result (Follow stacked on A's copy of the NPC). The conversation
  // itself pauses the game, and companion.lua only polls once it is closed -- as in play,
  // where the claim goes out after Goodbye. The server admits a follow claim on proximity.
  await a.cmd(`follow:${rec}`);
  await ctx.sleep(2_500); // companion.lua polls at 1 Hz
  await a.cmd(`followprobe:${rec}`);
  await ctx.sleep(1_000);
  ctx.log(`A followProbe=${await a.eval('window.omw.state.followProbe')}`);
  ctx.log('A luaErrors: ' + a.luaErrors().slice(-6).join(' || '));

  // Walk away -- to the spawn point, known dry land (an arbitrary offset put A in the bay).
  // The companion must come along -- on B's screen, which did nothing.
  const dest = { x: -12288, y: -69632, z: 87 };
  await a.cmd(`snapto:${Math.round(dest.x)},${Math.round(dest.y)},${Math.round(dest.z)}`);
  const deadline = Date.now() + 90_000;
  let dB = Infinity, dA = Infinity;
  while (Date.now() < deadline) {
    const [qa, qb] = await Promise.all([probeOf(a), probeOf(b)]);
    if (qa[rec]) dA = dist2(qa[rec], dest);
    if (qb[rec]) dB = dist2(qb[rec], dest);
    if (dB < 350 && dA < 350) break;
    await ctx.sleep(1_000);
  }
  const mpLines = (a.logTail ? a.logTail(600) : '').split(String.fromCharCode(10)).filter((l) => /follow|Follow|mpTestFollow|ActorAI/i.test(l)).slice(-8);
  ctx.log('A follow-related tail: ' + mpLines.join(' || '));
  ctx.log(`A testFollow=${await a.eval('window.omw.state.testFollow')} companionReport=${await a.eval('window.omw.state.companionReport')} followClaim=${await a.eval('window.omw.state.followClaim')}`);
  ctx.log(`companion distance to A after the walk: on A ${Math.round(dA)}, on B ${Math.round(dB)} (started ${Math.round(dist2(start, dest))} away)`);
  assert.ok(dB < 350, `B never saw "${rec}" follow A (${Math.round(dB)} units away): the recruit claim did not reach the holder, or the holder's follower is not relayed`);
  assert.ok(dA < 350, `A's own copy of "${rec}" did not arrive (${Math.round(dA)} units away)`);
  ctx.log(`ok: "${rec}" followed A, and B saw it come`);
}
