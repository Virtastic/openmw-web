// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s72: a merchant's PURSE is shared, not per-client. Two players open the same trader; the
// second must be told the canonical figure rather than trusting the full purse his own client
// rolled. This is the half of merchant duplication that survived the stock fix: selling into
// a wallet that never empties is how a shared economy stops meaning anything, and it is
// reachable in the first ten minutes of play.
//
// Deliberately asserts on the SECOND client's reading. The first opener is the one who
// defines canonical, so his own view agreeing with himself proves nothing at all.
import assert from 'node:assert/strict';

const STEP_TIMEOUT = 20_000;

const goldOf = async (c) => {
  const raw = await c.eval('(window.__omwMP||{}).barterGold||""');
  return raw === '' || raw === 'no-npc' ? null : Number(raw);
};

export default async function run(ctx) {
  const [a, b] = await Promise.all([
    ctx.launchClient('purse-a'),
    ctx.launchClient('purse-b'),
  ]);

  // A opens first: his reading becomes canonical for everyone.
  await a.eval(`Module.__omwMPCmd='barter:open'`);
  await a.waitFor('((window.__omwMP||{}).barterGold||"") !== ""', STEP_TIMEOUT,
    'A opened a barter window on some merchant');
  const aGold = await goldOf(a);
  assert.notEqual(aGold, null,
    'no living NPC in the start cell to trade with — the scenario needs one, this is not a product failure');
  ctx.log(`A sees the merchant holding ${aGold}`);

  // B opens the same trader. Before the purse was shared his client kept its own full roll.
  await b.eval(`Module.__omwMPCmd='barter:open'`);
  await b.waitFor('((window.__omwMP||{}).barterGold||"") !== ""', STEP_TIMEOUT,
    'B opened a barter window');
  const bGold = await goldOf(b);
  ctx.log(`B sees the merchant holding ${bGold}`);

  // The real assertion. Both clients rolled this merchant independently, so agreeing is only
  // possible if one figure is being handed to the other.
  assert.equal(bGold, aGold,
    `the second opener must see the CANONICAL purse, not his own client's (A ${aGold}, B ${bGold})`);
  ctx.log('ok: one purse, shared — the trader is not two traders');

  await Promise.all([
    a.eval(`Module.__omwMPCmd='barter:close'`),
    b.eval(`Module.__omwMPCmd='barter:close'`),
  ]);
}
