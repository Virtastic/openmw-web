// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s52 (M5): the PvP gate. With the server default ([rules] pvp = false) a hit aimed at
// another PLAYER must not land — the attacker suppresses it locally for honest feedback
// and the server's pvp plugin drops it regardless. B's health must be untouched.
import assert from 'node:assert/strict';

const STEP_TIMEOUT = 15_000;
const SETTLE_MS = 4000; // generous: we are proving that NOTHING happens

const hpOf = async (c) => Number(await c.eval('window.omw.state.hp||"0"'));

export default async function run(ctx) {
  const [a, b] = await Promise.all([ctx.launchClient('bot-a'), ctx.launchClient('bot-b')]);
  const idB = await b.eval('window.omw.state.playerId');

  await a.waitFor(`!!JSON.parse(window.omw.state.puppets||"{}")[${JSON.stringify(idB)}]`,
    STEP_TIMEOUT, 'puppet of B on A');
  await b.waitFor('Number(window.omw.state.hp||"0") > 0', STEP_TIMEOUT, 'B hp mirror live');
  await b.waitFor('window.omw.state.pvp === "false"', STEP_TIMEOUT, 'B sees pvp disabled');

  const hpBefore = await hpOf(b);
  await a.eval(`window.omw.send('hitp:${idB}:25')`);
  await ctx.sleep(SETTLE_MS);

  const hpAfter = await hpOf(b);
  ctx.log(`pvp off: B hp ${hpBefore} -> ${hpAfter}`);
  assert.equal(hpAfter, hpBefore, 'PvP disabled: B must take no damage');
  // And nothing was delivered to B at all (no CombatHit reached its combat applier).
  assert.equal(await b.eval('window.omw.state.lastHitTaken'), undefined,
    'no CombatHit should have been delivered to B');
  ctx.log('ok: PvP gate blocked the hit end to end');
}
