// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s125: STEALING HAS CONSEQUENCES, FOR THE WHOLE PARTY. A picks up something that belongs to
// the shopkeeper, in the shop, with the shopkeeper standing there. The take is a server
// request (s79), the granted take runs the engine's own ActionTake -- which is where theft
// is judged and the bounty raised -- the CrimeUpdate travels, and with [sharing] crime = true
// the party carries one record: B, who took nothing, is wanted too. Without the real
// ActionTake on the granted path, theft in a shared world would be free.
import assert from 'node:assert/strict';

export const managedPeer = true;
const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const cellOf = async (c) => String(await c.eval('window.omw.state.cell||""'));
const bountyOf = async (c) => Number(await c.eval('window.omw.state.bounty||"0"') || 0);

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  for (const c of [a, b]) await c.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 300_000, `${c.name} puppeted the cell actors`);
  const outside = await cellOf(a);
  for (const c of [a, b]) {
    await c.cmd('door:enter');
    await c.waitFor(`String(window.omw.state.cell||"") !== ${JSON.stringify(outside)}`, STEP, `${c.name} went inside`);
  }
  ctx.log(`both inside "${await cellOf(a)}"; bounties A=${await bountyOf(a)} B=${await bountyOf(b)}`);
  assert.equal(await bountyOf(a), 0, 'A starts clean');
  await ctx.sleep(3_000);

  await a.cmd('takeowned');
  await a.waitFor('String(window.omw.state.takeOwned||"") !== ""', STEP, 'A picked something to steal');
  const what = await a.eval('window.omw.state.takeOwned');
  ctx.log(`A steals: ${what}`);
  assert.notEqual(what, 'none', 'nothing owned in this shop');

  await a.waitFor('Number(window.omw.state.bounty||"0") > 0', 60_000, 'A is wanted (the theft was judged on the granted take)');
  const ba = await bountyOf(a);
  await b.waitFor('Number(window.omw.state.bounty||"0") > 0', STEP, 'B is wanted too (crime is shared with the party)');
  ctx.log(`ok: theft judged -- bounty A=${ba} B=${await bountyOf(b)}`);
}
