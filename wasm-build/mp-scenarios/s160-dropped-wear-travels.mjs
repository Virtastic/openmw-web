// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s160: A DROPPED ITEM IS THE ITEM, NOT ITS RECORD. A placement carried the record and the
// count, so a friend picked up a pristine copy of what was dropped: a worn cuirass came back
// new, a half-charged ring dropped and picked up was a free recharge. The item's own state
// (wear, charge, soul) rides the drop and the cell record. A drops a cuirass worn to 100;
// B picks it up and holds a cuirass at 100, not at full.
import assert from 'node:assert/strict';

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 }; // iron_cuirass is retail; the example suite has no armour by that name
const ITEM = 'iron_cuirass';
const WORN = 100;
async function stateOf(c, id) {
  await c.eval("if (window.omw.state) window.omw.state.itemState = null; 'cleared';");
  await c.cmd(`itemstate:${id}`);
  await c.waitFor("typeof window.omw.state.itemState === 'string'", 10_000, `${id} state answered`);
  return String(await c.eval('window.omw.state.itemState'));
}
const netObjs = async (c) => JSON.parse(await c.eval('window.omw.state.netObjects||"{}"'));

export default async function run(ctx) {
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  await a.cmd(`give:${ITEM}`);
  await ctx.sleep(500);
  await a.cmd(`setcond:${ITEM}:${WORN}`);
  const worn = await stateOf(a, ITEM);
  ctx.log(`A's cuirass before the drop: ${worn}`);
  assert.ok(worn.startsWith(`${WORN}/`), `the wear did not take on A (${worn})`);

  const before = Object.keys(await netObjs(a));
  await a.cmd(`drop:${ITEM}`);
  await a.waitFor(`Object.keys(JSON.parse(window.omw.state.netObjects||"{}")).length > ${before.length}`, STEP, 'the drop is netted on A');
  const netId = Object.keys(await netObjs(a)).find((id) => !before.includes(id));
  await b.waitFor(`!!JSON.parse(window.omw.state.netObjects||"{}")[${JSON.stringify(netId)}]`, STEP, 'the drop is placed on B');

  await b.cmd(`takenet:${netId}`);
  await b.waitFor(`!JSON.parse(window.omw.state.netObjects||"{}")[${JSON.stringify(netId)}]`, STEP, 'B picked it up');
  await ctx.sleep(500);
  const got = await stateOf(b, ITEM);
  ctx.log(`B's cuirass after the pickup: ${got}`);
  assert.ok(got.startsWith(`${WORN}/`), `B holds a pristine copy (${got}): the drop carried the record, not the item`);
  ctx.log('PASS: a worn item dropped for a friend is still worn in their hands');
}
