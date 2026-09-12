// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s115: A CONJURER'S SUMMON IS REAL FOR EVERYONE. Casting Summon Scamp puts an active spell on
// the caster's OWN body. On a simulated world the client does not spawn the creature (the
// spawn gate, s109); the spell rides PlayerActiveSpells to the avatar, the peer's engine
// summons the scamp beside the avatar, names it (s107), and every client builds it. If any
// hop is broken a conjurer's whole playstyle is a spell that does nothing.
import assert from 'node:assert/strict';

const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const SPELL = 'summon scamp';
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

  await a.cmd(`selfcast:${SPELL}`);
  await a.waitFor('String(window.omw.state.selfCast||"").indexOf("cast:") === 0', 15_000, 'the spell is active on A');
  ctx.log(`A selfCast=${await a.eval('window.omw.state.selfCast')}`);

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
