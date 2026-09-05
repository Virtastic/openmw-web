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
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// RETAIL. A purse belongs to a merchant, and the demo content has no NPCs to be one -- the
// same reason s31 has to spawn its own chest. There is no non-retail way to test this.
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const STEP_TIMEOUT = 20_000;

const goldOf = async (c) => {
  const raw = await c.eval('window.omw.state.barterGold||""');
  return raw === '' || raw === 'no-npc' ? null : Number(raw);
};

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required for a merchant)');
    return;
  }
  const [a, b] = await Promise.all([
    ctx.launchClient('purse-a', '', BOOT),
    ctx.launchClient('purse-b', '', BOOT),
  ]);

  // A opens first: his reading becomes canonical for everyone.
  await a.eval(`window.omw.send('barter:open')`);
  await a.waitFor('(window.omw.state.barterGold||"") !== ""', STEP_TIMEOUT,
    'A opened a barter window on some merchant');
  const aGold = await goldOf(a);
  assert.notEqual(aGold, null,
    'no living NPC in the start cell to trade with — the scenario needs one, this is not a product failure');
  ctx.log(`A sees the merchant holding ${aGold}`);

  // B opens the same trader. Before the purse was shared his client kept its own full roll.
  await b.eval(`window.omw.send('barter:open')`);
  await b.waitFor('(window.omw.state.barterGold||"") !== ""', STEP_TIMEOUT,
    'B opened a barter window');
  const bGold = await goldOf(b);
  ctx.log(`B sees the merchant holding ${bGold}`);

  // The real assertion. Both clients rolled this merchant independently, so agreeing is only
  // possible if one figure is being handed to the other.
  assert.equal(bGold, aGold,
    `the second opener must see the CANONICAL purse, not his own client's (A ${aGold}, B ${bGold})`);
  ctx.log('ok: one purse, shared — the trader is not two traders');

  await Promise.all([
    a.eval(`window.omw.send('barter:close')`),
    b.eval(`window.omw.send('barter:close')`),
  ]);
}
