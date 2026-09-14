// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s145: WHAT A FRIEND DOES WITH THEIR BODY IS SEEN. Run, sneak, jump, weapon out, spell
// ready -- the small posture facts every co-op game shows, and the ones a helper reads to
// know what their friend is doing. They ride the pose flags. Under the sim peer (the retail
// mode) the avatar stream used to forward only "attacking" and "weapon drawn": a sneaking
// friend walked upright on every other screen, never jumped, and never showed a spell
// stance. Asserted on the OBSERVER's screen: B's mirror of A's puppet (flags, jump edges,
// and the engine's own stance on the puppet body).
import assert from 'node:assert/strict';

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const RUN = 1, SNEAK = 2, WEAPON = 16, SPELL = 32;
const STANCE_WEAPON = 1, STANCE_SPELL = 2;

const bit = (flags, mask) => (Number(flags || 0) & mask) === mask;

export default async function run(ctx) {
  // Both at the retail start (Seyda Neen, -2,-9), on dry land.
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  await a.waitFor('String(window.omw.state.baselineReady||"") === "1"', 120_000, 'the character is settled (the join-time restore is done)');
  const idA = await a.eval('window.omw.state.playerId');
  const rowOf = `(JSON.parse(window.omw.state.puppets||"{}")[${JSON.stringify(String(idA))}]||{})`;
  await b.waitFor(`${rowOf}.x !== undefined`, 120_000, "B has a puppet of A");
  // The peer must hold the cell: that is the path under test (the avatar stream).
  await a.waitFor('Number(window.omw.state.puppetedActors||0) > 0', STEP, 'the cell is peer-held');
  const seen = async () => JSON.parse(await b.eval(`JSON.stringify(${rowOf})`));
  ctx.log(`ok: both in the peer-held cell, B sees A (idle flags on B=${(await seen()).flags}, A's own selfFlags=${await a.eval('window.omw.state.selfFlags')})`);

  const waitFlag = async (mask, what) => {
    await b.waitFor(`(Number(${rowOf}.flags||0) & ${mask}) === ${mask}`, STEP, `B sees A ${what}`);
    ctx.log(`ok: B sees A ${what} (flags=${(await seen()).flags})`);
  };

  // Sneak: a 4 s creep forward; the sneak bit must show on B while it lasts.
  await a.cmd('walk:0,1,4000:sneak');
  await waitFlag(SNEAK, 'sneaking');
  await b.waitFor(`(Number(${rowOf}.flags||0) & ${SNEAK}) === 0`, STEP, 'the sneak ends on B when A stops');

  // Run.
  await a.cmd('walk:0,-1,4000:run');
  await waitFlag(RUN, 'running');
  await b.waitFor(`(Number(${rowOf}.flags||0) & ${RUN}) === 0`, STEP, 'the run ends on B when A stops');

  // Jump: an edge, counted on B. Two jumps, two edges.
  const jumps0 = Number((await seen()).jumps || 0);
  await a.cmd('jump');
  await b.waitFor(`Number(${rowOf}.jumps||0) >= ${jumps0 + 1}`, STEP, 'B counts the first jump');
  await ctx.sleep(1500);
  await a.cmd('jump');
  await b.waitFor(`Number(${rowOf}.jumps||0) >= ${jumps0 + 2}`, STEP, 'B counts the second jump');
  ctx.log(`ok: B counted ${Number((await seen()).jumps) - jumps0} jumps`);

  // Weapon out: the bit AND the puppet body's own stance.
  await a.cmd('stance:weapon');
  await waitFlag(WEAPON, 'with a weapon out');
  await b.waitFor(`Number(${rowOf}.stance) === ${STANCE_WEAPON}`, STEP, "B's puppet of A holds the weapon stance");

  // Spell ready. The engine refuses the spell stance with nothing selected to cast, so give
  // the character a spell first (as any real character has).
  await a.cmd('learnspell:levitate');
  await a.cmd('stance:spell');
  await waitFlag(SPELL, 'with a spell ready');
  await b.waitFor(`Number(${rowOf}.stance) === ${STANCE_SPELL}`, STEP, "B's puppet of A holds the spell stance");
  assert.ok(!bit((await seen()).flags, WEAPON), 'weapon and spell stance are exclusive');

  ctx.log('PASS: run, sneak, jump, weapon and spell stances all reached the other screen through the peer');
}
