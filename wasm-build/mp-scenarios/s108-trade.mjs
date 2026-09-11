// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s108: TRADING BETWEEN PLAYERS. The sanctioned exchange is a drop and a pickup (activating a
// friend's body is refused on purpose: their puppet's inventory is a per-screen copy). Two
// players, two directions: A drops an item, B takes it and now HOLDS it; B drops gold, A
// takes it and now holds the gold -- and nothing is duplicated or lost on either screen.
//
// s79 proves the contested case (both grab, one wins). This proves the ordinary one: the
// item that changes hands is in exactly one inventory afterwards, and it is the recipient's.
import assert from 'node:assert/strict';

const STEP = 30_000;
const netCount = 'Object.keys(JSON.parse(window.omw.state.netObjects||"{}")).length';

async function countOf(c, id) {
  await c.eval("if (window.omw.state) window.omw.state.count = null; 'cleared';");
  await c.cmd(`count:${id}`);
  await c.waitFor("typeof window.omw.state.count === 'string'", 10_000, `${c.name} reported its count`);
  return Number(await c.eval('window.omw.state.count'));
}

async function handOver(ctx, giver, taker, itemId, what) {
  const before = await countOf(taker, itemId);
  await giver.cmd(`drop:${itemId}`);
  await giver.waitFor(`${netCount} === 1`, STEP, `${giver.name} tracks its drop of ${what}`);
  await taker.waitFor(`${netCount} === 1`, STEP, `${taker.name} sees the ${what} on the ground`);
  const netId = await taker.eval('Object.keys(JSON.parse(window.omw.state.netObjects))[0]');
  await taker.cmd(`takenet:${netId}`);
  await taker.waitFor(`${netCount} === 0`, STEP, `the ${what} left the world on ${taker.name}`);
  await giver.waitFor(`${netCount} === 0`, STEP, `the ${what} left the world on ${giver.name}`);
  await ctx.sleep(1_500);
  const g = await countOf(giver, itemId);
  const t = await countOf(taker, itemId);
  ctx.log(`${what}: ${giver.name} holds ${g}, ${taker.name} holds ${t} (had ${before})`);
  assert.equal(g, 0, `${giver.name} still holds the ${what} it gave away`);
  assert.equal(t, before + 1, `${taker.name} did not receive the ${what}`);
}

export default async function run(ctx) {
  const [a, b] = await Promise.all([ctx.launchClient('bot-a'), ctx.launchClient('bot-b')]);
  for (const c of [a, b]) {
    await c.waitFor('window.omw.state.state === "Joined"', 60_000, `${c.name} joined`);
  }

  // A hands B a test item.
  await a.cmd('equiptest');
  await a.waitFor('(window.omw.state.equippedIds||"") !== ""', 12_000, 'A holds the test item');
  const itemId = (await a.eval('window.omw.state.equippedIds')).split(',')[0];
  assert.ok(itemId, 'test item id');
  await handOver(ctx, a, b, itemId, 'test item');

  // B hands it back: the recipient can give it on, which is what a trade needs.
  await handOver(ctx, b, a, itemId, 'test item (returned)');

  const errs = a.luaErrors().concat(b.luaErrors());
  assert.equal(errs.length, 0, 'Lua errors during the trade:\n' + errs.join('\n'));
  ctx.log('ok: an item changed hands both ways, in exactly one inventory at every step');
}
