// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s109: TWO PLAYERS KILL A WILD CREATURE. The most common fight in the game is against a
// levelled-list creature -- and since s107 those are NAMED runtime actors (the peer's, addressed
// by net id), not content refs like the NPCs s51 hits. s51 picks its victim from the probe and
// happened to pick a mudcrab once, and the mudcrab never died. This targets a net actor BY
// CONSTRUCTION: both clients snap into open country, wait for the peer to name a creature, and
// both players fight it FOR REAL -- W to walk up, the mouse button to swing (_realfight.mjs).
// The peer's avatars swing and resolve every blow against the creature they simulate; each
// client only cancels its local copy. It must die once, for both, and neither client may have
// forwarded a hit of its own (a real swing is never relayed: that would land it twice).
import assert from 'node:assert/strict';
import { focus, armMelee, swingUntil, probeOf as probeRec } from './_realfight.mjs';

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const SPOT = '-12500,-53100,512'; // inside -2,-7, where the live run named scrib / kwama forager

const netObjs = async (c) => JSON.parse(await c.eval('window.omw.state.netObjects||"{}"'));
const probeOf = async (c) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'));

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-7');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  await a.cmd('snapto:' + SPOT);
  await b.cmd('snapto:' + SPOT);

  // A creature the peer named, built on both screens.
  await a.waitFor('Object.keys(JSON.parse(window.omw.state.netObjects||"{}")).length > 0', 120_000, 'A built a named creature');
  await b.waitFor('Object.keys(JSON.parse(window.omw.state.netObjects||"{}")).length > 0', 120_000, 'B built a named creature');
  const oa = await netObjs(a), ob = await netObjs(b);
  const shared = Object.keys(oa).find((id) => ob[id] === oa[id]);
  assert.ok(shared, `no creature both clients agree on: A=${JSON.stringify(oa)} B=${JSON.stringify(ob)}`);
  const victim = oa[shared];
  ctx.log(`both clients attacking the peer's "${victim}" (net ${shared})`);

  // Both puppeted it (the non-holder sweep), so the interceptor is armed on both.
  for (const c of [a, b]) {
    await c.waitFor('Number(window.omw.state.puppetedActors||0) > 0', STEP, `${c.name} puppeted the cell actors`);
  }

  const deadExpr = `((JSON.parse(window.omw.state.actorProbe||"{}")[${JSON.stringify(victim)}]||{}).dead === true)`;
  const fwd0 = await Promise.all([a, b].map((c) => c.eval('String(window.omw.state.hitFwdCount||0)')));
  for (const c of [a, b]) { await focus(c); await armMelee(c); }
  const dead = async () => (await a.eval(deadExpr)) === true || (await b.eval(deadExpr)) === true;
  // Both fight at once, each on its own screen.
  const [ra, rb] = await Promise.all([a, b].map((c) =>
    swingUntil(ctx, c, () => probeRec(c, victim), dead, { budgetMs: 240_000 })));
  ctx.log(`A swung ${ra.swings} (${ra.snaps} snap(s)), B swung ${rb.swings} (${rb.snaps}); dead=${ra.done || rb.done}`);
  const died = await dead();
  assert.ok(ra.swings + rb.swings > 0, 'nobody swung: the creature was never in reach');
  assert.ok(died, `the ${victim} never died from ${ra.swings + rb.swings} real swings: the avatars' blows on a NAMED runtime creature `
    + 'are not landing on the peer, or the peer cannot resolve its own net actor');
  const fwd1 = await Promise.all([a, b].map((c) => c.eval('String(window.omw.state.hitFwdCount||0)')));
  assert.deepEqual(fwd1, fwd0, `a real swing was forwarded by a client (${fwd0} -> ${fwd1}): the blow would land twice`);
  await a.waitFor(deadExpr, STEP, 'A sees it dead');
  await b.waitFor(deadExpr, STEP, 'B sees it dead');
  const pa = await probeOf(a), pb = await probeOf(b);
  assert.equal(pa[victim]?.dead, true); assert.equal(pb[victim]?.dead, true);
  ctx.log(`ok: the peer's ${victim} died once, for both players`);
}
