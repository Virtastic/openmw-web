// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s153: WHAT YOU MADE COMES BACK WHEN YOU DO. A brewed potion or a self-enchanted ring is a
// player-made record, a `Generated:` id that means nothing to the next engine. Equipment and
// the spellbook already travel by the server's record id; the inventory declaration went out
// RAW, so on relog the doc named a record the new engine did not have -- the item was lost,
// or worse, rebuilt as whatever the new engine had minted under that number. Every alchemist
// hit this at their first relog. Now the inventory maps through the registry and the restore
// waits for RecordsSync before it grants.
import assert from 'node:assert/strict';

const STEP = 30_000;
const NAME = 'Relog Brew';
async function countOf(c, id) {
  await c.eval("if (window.omw.state) window.omw.state.count = null; 'cleared';");
  await c.cmd(`count:${id}`);
  await c.waitFor("typeof window.omw.state.count === 'string'", 10_000, `count of ${id} answered`);
  return Number(await c.eval('window.omw.state.count'));
}
const netRecords = async (c) => JSON.parse(await c.eval('window.omw.state.netRecords||"{}"'));

export default async function run(ctx) {
  const a = await ctx.launchClient('bot-a');
  await a.waitFor('String(window.omw.state.baselineReady||"") === "1"', STEP, 'settled');

  // Make a record (registered with the server, one granted -- the alchemy outcome).
  await a.cmd(`mkrec:${NAME}`);
  await a.waitFor('String(window.omw.state.lastRecordLocalId||"") !== ""', STEP, 'the record was minted');
  const localId = await a.eval('window.omw.state.lastRecordLocalId');
  await a.waitFor(`Object.values(JSON.parse(window.omw.state.netRecords||"{}")).includes(${JSON.stringify(localId)})`, STEP, 'registered with the server');
  const netId = Object.entries(await netRecords(a)).find(([, l]) => l === localId)[0];
  assert.equal(await countOf(a, localId), 1, 'the made item must be in the pack');
  ctx.log(`made ${localId} = server ${netId}; in the pack`);
  // Let the inventory declaration (2 s cadence, then a re-send if the record was still
  // registering) reach the server.
  await ctx.sleep(6_000);
  a.close(); // the server flushes the doc on logout

  // Back on the same account, in a fresh engine: the record is rebuilt from RecordsSync under
  // a new local id, and the restore must grant the item under THAT id.
  await ctx.sleep(2_000);
  const a2 = await ctx.launchClient('bot-a');
  await a2.waitFor('window.omw.state.restored === "1"', 120_000, 'rejoin restore applied');
  await a2.waitFor(`JSON.parse(window.omw.state.netRecords||"{}")[${JSON.stringify(netId)}] !== undefined`, STEP, 'the record came back through RecordsSync');
  const localId2 = (await netRecords(a2))[netId];
  ctx.log(`after relog the record is ${localId2}`);
  const n = await countOf(a2, localId2);
  assert.equal(n, 1, `the made item did not come back (${n} of ${localId2} in the pack): the inventory named it by a local id, or the restore ran before RecordsSync`);
  ctx.log(`PASS: a player-made item survived a relog (${localId} -> ${netId} -> ${localId2})`);
}
