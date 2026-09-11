// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s109: TWO PLAYERS KILL A WILD CREATURE. The most common fight in the game is against a
// levelled-list creature -- and since s107 those are NAMED runtime actors (the peer's, addressed
// by net id), not content refs like the NPCs s51 hits. s51 picks its victim from the probe and
// happened to pick a mudcrab once, and the mudcrab never died. This targets a net actor BY
// CONSTRUCTION: both clients snap into open country, wait for the peer to name a creature, hit
// the one both can see, and it must die -- once, for both -- through the hit chain that
// addresses it by net id at every hop (client puppet -> server -> peer -> the creature).
import assert from 'node:assert/strict';

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
  const deadline = Date.now() + 90_000;
  let died = false;
  while (Date.now() < deadline && !died) {
    await a.cmd(`hitn:${victim}:40`);
    await b.cmd(`hitn:${victim}:40`);
    await ctx.sleep(600);
    died = (await a.eval(deadExpr)) === true || (await b.eval(deadExpr)) === true;
  }
  ctx.log(`hitFwd A=${await a.eval('window.omw.state.hitFwd')} B=${await b.eval('window.omw.state.hitFwd')}`);
  assert.ok(died, `the ${victim} never died: hits on a NAMED runtime creature are not reaching the peer, `
    + 'or the peer cannot resolve the net id to its own creature -- see the peer tail below');
  await a.waitFor(deadExpr, STEP, 'A sees it dead');
  await b.waitFor(deadExpr, STEP, 'B sees it dead');
  const pa = await probeOf(a), pb = await probeOf(b);
  assert.equal(pa[victim]?.dead, true); assert.equal(pb[victim]?.dead, true);
  ctx.log(`ok: the peer's ${victim} died once, for both players`);
}
