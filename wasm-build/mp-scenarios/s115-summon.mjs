// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s115: A CONJURER'S SUMMON IS REAL FOR EVERYONE. Casting Summon Scamp puts an active spell on
// the caster's OWN body. On a simulated world the client does not spawn the creature (the
// spawn gate, s109); the spell rides PlayerActiveSpells to the avatar, the peer's engine
// summons the scamp beside the avatar, names it (s107), and every client builds it. If any
// hop is broken a conjurer's whole playstyle is a spell that does nothing.
import assert from 'node:assert/strict';
import { prepareCast, SUMMON_SCAMP } from './_spell.mjs';

const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const SPELL = SUMMON_SCAMP;
const netObjs = async (c) => JSON.parse(await c.eval('window.omw.state.netObjects||"{}"'));
const summoned = (objs) => Object.entries(objs).find(([, rec]) => /scamp/i.test(String(rec)));

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  for (const c of [a, b]) await c.waitFor('window.omw.state.state === "Joined"', 60_000, `${c.name} joined`);
  await a.waitFor('window.omw.state.localSpawns === "off"', 60_000, 'A is not spawning its own creatures (simulated world)');
  const before = summoned(await netObjs(a));
  assert.ok(!before, `a scamp is already named before the cast: ${JSON.stringify(before)}`);

  // A REAL CAST (backlog 242): the spell learned and selected, the spell stance, the use
  // key on A's own engine. The selfcast: hook added the active spell directly and stayed
  // green with the cast path dead. Pressed until the engine lists it active (a fizzle is
  // the spell system working, not the thing under test).
  await prepareCast(a, ctx, SPELL, 'conjuration');
  let actives = '';
  for (let attempt = 0; attempt < 4 && !actives.split(',').includes(SPELL); attempt++) {
    await a.cmd('press:500');
    await ctx.sleep(1_800);
    await a.eval("if (window.omw.state) window.omw.state.actives = null; 'cleared';");
    await a.cmd('actives');
    await a.waitFor("typeof window.omw.state.actives === 'string'", 10_000, 'actives answered');
    actives = String(await a.eval('window.omw.state.actives'));
  }
  ctx.log(`A cast ${SPELL}: active spells [${actives}]`);
  assert.ok(actives.split(',').includes(SPELL), `the cast of ${SPELL} never took on A (actives: ${actives})`);

  const deadline = Date.now() + 60_000;
  let onA = null, onB = null;
  while (Date.now() < deadline && !(onA && onB)) {
    onA = summoned(await netObjs(a)); onB = summoned(await netObjs(b));
    if (onA && onB) break;
    await ctx.sleep(1_000);
  }
  ctx.log(`scamp on A=${JSON.stringify(onA)} on B=${JSON.stringify(onB)}; A netObjects=${await a.eval('window.omw.state.netObjects')}`);
  assert.ok(onA, 'the caster never saw their own scamp: the active spell did not reach the avatar, or the peer did not summon, or it was not named');
  assert.ok(onB, 'the other player never saw the scamp: it was not named for everyone');
  assert.equal(onA[0], onB[0], 'both see the same net id');
  ctx.log(`ok: "${onA[1]}" (net ${onA[0]}) stands on both screens`);
}
