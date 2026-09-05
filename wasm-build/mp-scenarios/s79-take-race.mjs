// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s79: TWO PLAYERS REACH FOR THE SAME ITEM. Exactly one may keep it.
//
// A pickup used to be an announcement: the engine moved the item into the inventory natively
// and an ObjectDelete was relayed afterwards, which the server accepts idempotently. So two
// players activating the same item BOTH kept it -- a duplication race in the most ordinary
// interaction in the game. It is a request now (ObjectTakeRequest -> ObjectTakeResult), the
// activation handler holds the native take until the answer, and the loser is told 'gone'.
//
// Driven through the real activation pipeline (takenet -> activateBy), so the veto under test
// is the one a mouse click hits.
import assert from 'node:assert/strict';

const STEP = 30_000;
const netCount = 'Object.keys(JSON.parse(window.omw.state.netObjects||"{}")).length';

async function countOf(c, id) {
  await c.eval("if (window.omw.state) window.omw.state.count = null; 'cleared';");
  await c.cmd(`count:${id}`);
  await c.waitFor("typeof window.omw.state.count === 'string'", 10_000, `${c.name} reported its count`);
  return Number(await c.eval('window.omw.state.count'));
}

export default async function run(ctx) {
  const [a, b] = await Promise.all([ctx.launchClient('bot-a'), ctx.launchClient('bot-b')]);

  // THE VETO MUST HAVE ARMED, or nothing below measures what it claims to. objects.init prints
  // how many item types it registered; the first version registered ZERO (pairs(types) through
  // the read-only proxy matched nothing), the native take ran with nobody asking, and this
  // scenario failed on inventory counts with no hint why. logTail collapses duplicate lines so
  // the init-time print is still reachable.
  for (const c of [a, b]) {
    const line = (c.logTail ? c.logTail(600) : '').split('\n').find((l) => l.includes('pickup veto armed for'));
    const n = line ? Number((line.match(/armed for (\d+)/) || [])[1]) : NaN;
    assert.ok(Number.isFinite(n) && n >= 12,
      `${c.name}: the pickup veto did not arm (${line ? line.trim() : 'no registration line in the log'}). ` +
      'objects.init registers an I.Activation handler per carriable type; if the count is 0 the ' +
      'type names no longer match the engine (mwlua ObjectTypeName) and every pickup is a silent native take.');
  }

  // A materialises an item and drops it into the world; both see it as a net object.
  await a.cmd('equiptest');
  await a.waitFor('(window.omw.state.equippedIds||"") !== ""', 12_000, 'A holds the test item');
  const itemId = (await a.eval('window.omw.state.equippedIds')).split(',')[0];
  assert.ok(itemId, 'test item id');
  await a.cmd(`drop:${itemId}`);
  await a.waitFor(`${netCount} === 1`, STEP, 'A tracks its drop');
  await b.waitFor(`${netCount} === 1`, STEP, 'B sees the drop');
  const netId = await b.eval('Object.keys(JSON.parse(window.omw.state.netObjects))[0]');
  ctx.log(`item ${itemId} is net object ${netId}; both hold 0 of it`);
  assert.equal(await countOf(a, itemId), 0, 'A dropped it, so A holds none');
  assert.equal(await countOf(b, itemId), 0);

  // THE RACE: both activate it as close to simultaneously as two sockets allow.
  await Promise.all([a.cmd(`takenet:${netId}`), b.cmd(`takenet:${netId}`)]);

  // It must leave the world for BOTH -- the winner by taking it, the loser by the relay.
  await a.waitFor(`${netCount} === 0`, STEP, 'the item left the world on A');
  await b.waitFor(`${netCount} === 0`, STEP, 'the item left the world on B');

  // Let the winner's ActionTake (a delayed action) land before counting.
  await ctx.sleep(2_000);
  const ca = await countOf(a, itemId);
  const cb = await countOf(b, itemId);
  ctx.log(`after the race: A holds ${ca}, B holds ${cb}`);
  assert.equal(ca + cb, 1,
    `exactly one player may keep a contested item; A=${ca} B=${cb}. 2 = the duplication race is `
    + 'back (the native take ran on both), 0 = the winner never applied the granted take.');

  const errs = a.luaErrors().concat(b.luaErrors());
  assert.equal(errs.length, 0, 'Lua errors during the race:\n' + errs.join('\n'));
  ctx.log('ok: one winner, one told gone, no duplicate');
}
