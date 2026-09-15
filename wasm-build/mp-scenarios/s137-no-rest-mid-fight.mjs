// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s137: YOU CANNOT REST WITH ENEMIES NEARBY -- still true when the enemy is the PEER's.
// The fight runs on the sim peer: the creature's Combat package lives there, not on the
// player's own engine, where the creature is a puppet with its AI off. Vanilla's rest gate
// (World::canRest -> Player::enemiesNearby -> AiSequence::isInCombat(player)) reads the LOCAL
// package stack, so unless the peer's fight reaches this screen as a Combat package on the
// puppet (companion.lua reports it, ActorAI relays it, actors.lua stacks it), the player can
// open the rest dialog mid-bite. MP-COVERAGE-MAP listed this as unproven. This asks the
// engine's own verdict (mp.canRest, bit 4) before and after picking the fight.
import assert from 'node:assert/strict';

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const SPOT = '-12500,-53100,512'; // inside -2,-7, where the peer names scrib / kwama forager (s109)
const ENEMIES_NEARBY = 4; // MWBase::World::Rest_EnemiesAreNearby

const netObjs = async (c) => JSON.parse(await c.eval('window.omw.state.netObjects||"{}"'));
async function canRest(c) {
  await c.eval("if (window.omw.state) window.omw.state.canRest = null; 'cleared';");
  await c.cmd('canrest');
  await c.waitFor("typeof window.omw.state.canRest === 'string'", 10_000, 'the engine answered canRest');
  return Number(await c.eval('window.omw.state.canRest'));
}

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-7');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const a = await ctx.launchClient('bot-a', '', BOOT);
  await a.cmd('snapto:' + SPOT);
  await a.waitFor('Object.keys(JSON.parse(window.omw.state.netObjects||"{}")).length > 0', 120_000, 'the peer named a creature');
  await a.waitFor('Number(window.omw.state.puppetedActors||0) > 0', STEP, 'the cell is puppeted (the peer holds it)');
  const oa = await netObjs(a);
  const [netId, victim] = Object.entries(oa)[0];
  ctx.log(`the peer's "${victim}" (net ${netId}) is here`);

  const before = await canRest(a);
  assert.ok(before >= 0, `mp.canRest is not bound on this engine (${before})`);
  ctx.log(`rest verdict before the fight: ${before} (enemies-nearby bit ${(before & ENEMIES_NEARBY) ? 'SET' : 'clear'})`);
  // The bit must be CLEAR before the fight, or the flip below is not this scenario's doing.
  assert.equal(before & ENEMIES_NEARBY, 0, `enemies-nearby already set before any hit (verdict ${before}); the fight below proves nothing`);

  // Pick the fight: a light hit, so the creature turns on us rather than dying. The swing
  // goes to the peer, the peer's creature enters Combat with our avatar, companion.lua
  // reports it, and the puppet on THIS screen must gain the Combat package.
  const deadline = Date.now() + 90_000;
  let verdict = before;
  while (Date.now() < deadline && !(verdict & ENEMIES_NEARBY)) {
    await a.cmd(`hitn:${victim}:3`);
    await ctx.sleep(1_500);
    verdict = await canRest(a);
  }
  ctx.log(`rest verdict in the fight: ${verdict} (hitFwd=${await a.eval('window.omw.state.hitFwd')})`);
  const mpLines = (a.logTail ? a.logTail(400) : '').split(String.fromCharCode(10)).filter((l) => /combat|Combat|ActorAI/.test(l) && /\[mp\]/.test(l)).slice(-8);
  ctx.log('A [mp] combat tail: ' + mpLines.join(' || '));
  assert.ok(verdict & ENEMIES_NEARBY,
    "the engine would let the player rest mid-fight: the peer's fight never reached this screen as a Combat package on the puppet");
  ctx.log("PASS: a fight the peer runs against you counts as 'enemies nearby' on your own screen; the rest dialog is refused");
}
