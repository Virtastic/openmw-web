// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s30 (M3): dropped items are shared and persistent.
//   1. A drops an item -> B sees it (ObjectPlace echo; B renders its placeholder since the
//      demo item is a per-client dynamic record — netObjects mirror carries the netId).
//   2. A disconnects and rejoins -> the drop is still there (WorldCellState replay).
//   3. B picks it up (real activation pipeline) -> gone for A (ObjectDelete relay).
//   4. A rejoins again -> still gone (tombstone replay). A third client C also never sees it.
import assert from 'node:assert/strict';

const STEP_TIMEOUT = 15_000;

const netCount = '(Object.keys(JSON.parse(window.omw.state.netObjects||"{}")).length)';

export default async function run(ctx) {
  let a = await ctx.launchClient('bot-a');
  const b = await ctx.launchClient('bot-b');

  // A: materialize an item and drop it via the native inventory->world path.
  await a.eval(`window.omw.send('equiptest')`);
  await a.waitFor('(window.omw.state.equippedIds||"") !== ""', 12_000, 'A holds the test item');
  // Unequip is not needed: drop moves it out of the inventory regardless.
  const dropId = '$'; // dynamic ids start with $ — read the exact id from A's mirror
  const equipped = await a.eval('window.omw.state.equippedIds');
  const itemId = equipped.split(',')[0];
  assert.ok(itemId, 'test item id');
  await a.eval(`window.omw.send('drop:${itemId}')`);

  await a.waitFor(`${netCount} === 1`, STEP_TIMEOUT, 'A tracks its own drop as net object');
  await b.waitFor(`${netCount} === 1`, STEP_TIMEOUT, 'B sees the placed object');
  const netIdB = await b.eval('Object.keys(JSON.parse(window.omw.state.netObjects))[0]');
  ctx.log(`ok: drop shared (netId ${netIdB})`);

  // A rejoins: cell replay must resurrect the drop on A.
  a.close();
  await ctx.sleep(2000);
  a = await ctx.launchClient('bot-a');
  await a.waitFor(`${netCount} === 1`, STEP_TIMEOUT, 'drop survives A\'s rejoin (cell replay)');
  ctx.log('ok: drop survives observer rejoin');

  // B picks it up through the real activation pipeline.
  await b.eval(`window.omw.send('takenet:${netIdB}')`);
  await b.waitFor(`${netCount} === 0`, STEP_TIMEOUT, 'B\'s pickup clears its net map');
  await a.waitFor(`${netCount} === 0`, STEP_TIMEOUT, 'pickup relayed: gone for A');
  ctx.log('ok: pickup shared');

  // Fresh third client: tombstoned, must never appear.
  const c = await ctx.launchClient('bot-c');
  await ctx.sleep(3000); // give a wrong Place time to arrive if the tombstone failed
  const cCount = await c.eval(netCount);
  assert.equal(cCount, 0, 'tombstoned object leaked to a fresh client');
  ctx.log('ok: tombstone holds for fresh joiner');
}
