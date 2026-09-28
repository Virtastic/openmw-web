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
import { pickUntil } from './_probe.mjs';
import { focus, armMelee, swingUntil, probeOf as probeRec } from './_realfight.mjs';

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
  // One a provoking swing cannot kill before its fight registers (#175: an 8 hp scrib died to
  // the first blow that landed, and there was no fight left to see).
  const probeAll = async (c) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'));
  const { found: victim } = await pickUntil(ctx, async () => [Object.values(await netObjs(a)), await probeAll(a)],
    (names, probe) => names.find((r) => probe[r] && !probe[r].dead && !(probe[r].hp >= 0 && probe[r].hp < 20)) ?? names.find((r) => probe[r] && !probe[r].dead));
  ctx.log(`the peer's "${victim}" is here (hp ${(await probeRec(a, victim))?.hp})`);

  const before = await canRest(a);
  assert.ok(before >= 0, `mp.canRest is not bound on this engine (${before})`);
  ctx.log(`rest verdict before the fight: ${before} (enemies-nearby bit ${(before & ENEMIES_NEARBY) ? 'SET' : 'clear'})`);
  // The bit must be CLEAR before the fight, or the flip below is not this scenario's doing.
  assert.equal(before & ENEMIES_NEARBY, 0, `enemies-nearby already set before any hit (verdict ${before}); the fight below proves nothing`);

  // Pick the fight: a light hit, so the creature turns on us rather than dying. The swing
  // goes to the peer, the peer's creature enters Combat with our avatar, companion.lua
  // reports it, and the puppet on THIS screen must gain the Combat package.
  // FOR REAL, and weakly (longblade 40): a real swing that starts the fight without ending it.
  let verdict = before;
  const inFight = async () => { verdict = await canRest(a); return (verdict & ENEMIES_NEARBY) !== 0; };
  await focus(a); await armMelee(a, undefined, 40);
  const poke = await swingUntil(ctx, a, () => probeRec(a, victim), inFight, { maxSwings: 12, budgetMs: 90_000 });
  ctx.log(`provoked with ${poke.swings} real swing(s)`);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !(await inFight())) await ctx.sleep(1_500);
  ctx.log(`rest verdict in the fight: ${verdict} (hitFwd=${await a.eval('window.omw.state.hitFwd')})`);
  const mpLines = (a.logTail ? a.logTail(400) : '').split(String.fromCharCode(10)).filter((l) => /combat|Combat|ActorAI/.test(l) && /\[mp\]/.test(l)).slice(-8);
  ctx.log('A [mp] combat tail: ' + mpLines.join(' || '));
  assert.ok(verdict & ENEMIES_NEARBY,
    "the engine would let the player rest mid-fight: the peer's fight never reached this screen as a Combat package on the puppet");
  ctx.log("PASS: a fight the peer runs against you counts as 'enemies nearby' on your own screen; the rest dialog is refused");
}
