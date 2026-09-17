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
import { goToCompanion } from './_companion.mjs';

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

  // Stand beside them first, as you do to talk. The probe is STALE on an in-suite client
  // (a fraction of 1 fps): a wanderer may be ~1000 u from here by the time the avatar
  // lands (#112/#113). That is fine for the conversation (the lock is cell-scoped) and is
  // put right after the claim, when the NPC stops wandering (goToCompanion).
  await a.cmd(`snapto:${Math.round(start.x + 80)},${Math.round(start.y)},${Math.round(start.z + 8)}`);
  await ctx.sleep(4_000);

  // Recruit: the dialogue result (Follow stacked on A's copy of the NPC). The conversation
  // itself pauses the game, and companion.lua only polls once it is closed -- as in play,
  // where the claim goes out after Goodbye. The server admits the claim only under the
  // dialogue lock (#363), so hold it across the hook as s124 does.
  await a.cmd(`dlg:${rec}`);
  // The lock is the whole point (#363): wait for the server's grant rather than a guessed
  // 1.5 s, and say what the mirror holds if it never comes (quests.lua mirrorLock).
  await a.waitFor('/"granted":true/.test(window.omw.state.dialogueLock||"")', 15_000, `the dialogue lock on "${rec}" was granted`)
    .catch(async (e) => { ctx.log(`dialogueLock mirror: ${await a.eval('window.omw.state.dialogueLock')}`); throw e; });
  await ctx.sleep(500);
  await a.cmd(`follow:${rec}`);
  await a.cmd('dlg:release');
  await ctx.sleep(2_500); // companion.lua polls at 1 Hz
  // The claim is on the holder now; AiFollow activates only with A in range and in sight
  // (backlog 453), so go and stand where the peer really has them before walking off.
  await goToCompanion(ctx, a, rec, start);
  await a.cmd(`followprobe:${rec}`);
  await ctx.sleep(1_000);
  ctx.log(`A followProbe=${await a.eval('window.omw.state.followProbe')}`);
  ctx.log('A luaErrors: ' + a.luaErrors().slice(-6).join(' || '));

  // Walk away -- to the spawn point, known dry land (an arbitrary offset put A in the bay).
  // The companion must come along -- on B's screen, which did nothing.
  const dest = { x: -12288, y: -69632, z: 87 };
  // B'S ENGINE MUST BE RUNNING FOR B'S PROBE TO MEAN ANYTHING (backlog 478). The probe is a
  // mirror the global script rewrites every 0.5 s of ENGINE time; a client whose main loop
  // has stopped keeps handing back the last value forever, and 90 identical reads then look
  // like a companion rooted on B's screen. #115: B's last input frame reached the server at
  // 12:33:52, six seconds BEFORE this walk (simpeer.avatar_stats_gated lastInputAgoMs 62431),
  // and its copy read 826 u from here -- the spot the NPC had settled at -- for the whole poll.
  // actorBatchesIn counts the holder's frames as B's engine takes them (s42 uses it the same
  // way): stuck means B stopped, and the verdict must say so instead of blaming the chain.
  const batchesIn = (c) => c.eval('Number(window.omw.state.actorBatchesIn||0)');
  const bIn0 = await batchesIn(b);
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
  const bIn1 = await batchesIn(b);
  const mpLines = (a.logTail ? a.logTail(600) : '').split(String.fromCharCode(10)).filter((l) => /follow|Follow|mpTestFollow|ActorAI/i.test(l)).slice(-8);
  ctx.log('A follow-related tail: ' + mpLines.join(' || '));
  ctx.log(`A testFollow=${await a.eval('window.omw.state.testFollow')} companionReport=${await a.eval('window.omw.state.companionReport')} followClaim=${await a.eval('window.omw.state.followClaim')}`);
  ctx.log(`companion distance to the walk-off spot: on A ${Math.round(dA)}, on B ${Math.round(dB)} (started ${Math.round(dist2(start, dest))} away); B took ${bIn1 - bIn0} actor frames during the walk`);
  if (dB >= 350 && bIn1 === bIn0) {
    ctx.log(`B jsErrors: ${b.jsErrors().slice(-4).join(' || ')} || luaErrors: ${b.luaErrors().slice(-4).join(' || ')}`);
    ctx.log('B tail: ' + b.logTail(12).split(String.fromCharCode(10)).join(' || '));
    assert.fail(`B's engine stopped before the walk (actorBatchesIn stuck at ${bIn0} for 90 s): its probe of "${rec}" is a frozen mirror, not a stuck puppet -- a client fault, not the companion chain`);
  }
  assert.ok(dB < 350, `B never saw "${rec}" follow A (${Math.round(dB)} units away): the recruit claim did not reach the holder, or the holder's follower is not relayed`);
  assert.ok(dA < 350, `A's own copy of "${rec}" did not arrive (${Math.round(dA)} units away)`);
  ctx.log(`ok: "${rec}" followed A, and B saw it come`);
}
