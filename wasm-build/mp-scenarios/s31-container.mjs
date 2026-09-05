// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s31 (M3): container transactionality. A spawns a chest (net-addressed; B holds a
// placeholder object but the container STATE syncs), puts one item in, both clients open
// it, then both race a take of the SAME single item. The server is the serialization
// point: exactly one ContainerOpResult ok=true, and the canonical chest inventory drops
// 1 -> 0 with no duplication (conservation at the source of truth).
import assert from 'node:assert/strict';

// A SYNC BOUND, not a frame-rate benchmark. 15 s was chosen against a machine with a GPU; on
// the GPU-less test box the clients render through SwiftShader and their JOINS alone measured
// 23-28 s, so a container round trip that is genuinely prompt still misses this. Observed
// passing when run completely alone and failing in any group -- which is the signature of a
// test measuring the machine rather than the product, the failure mode this repo has already
// been bitten by twice (s44, s57).
//
// 30 s is still a real assertion: the mirror publishes twice a second and the op is one
// server round trip, so anything approaching this is a genuine stall in container sync and
// not a slow renderer. Overridable so a fast machine can hold itself to a tighter bar.
const STEP_TIMEOUT = Number(process.env.OMW_STEP_TIMEOUT_MS || 30_000);

export default async function run(ctx) {
  const [a, b] = await Promise.all([
    ctx.launchClient('bot-a'),
    ctx.launchClient('bot-b'),
  ]);

  await a.eval(`window.omw.send('equiptest')`);
  await a.waitFor('(window.omw.state.equippedIds||"") !== ""', 12_000, 'A holds the test item');
  const itemId = (await a.eval('window.omw.state.equippedIds')).split(',')[0];

  await a.eval(`window.omw.send('chest:spawn')`);
  await a.waitFor('Object.keys(JSON.parse(window.omw.state.netObjects||"{}")).length === 1',
    STEP_TIMEOUT, 'chest netted on A');
  const netId = await a.eval('Object.keys(JSON.parse(window.omw.state.netObjects))[0]');
  await b.waitFor(`!!JSON.parse(window.omw.state.netObjects||"{}")[${JSON.stringify(netId)}]`,
    STEP_TIMEOUT, 'chest placed on B');

  // A opens (registers canonical contents = empty), puts the item in.
  await a.eval(`window.omw.send('chest:open')`);
  // WAIT FOR THE OPEN TO LAND BEFORE ISSUING THE NEXT COMMAND. Two reasons, and the second is
  // the one that actually bit:
  //   1. the ContainerOpen round trip (open -> server -> canonical state -> mirror) does not
  //      fit inside a fixed 500 ms on a loaded box; and
  //   2. The bridge queue used to be a SINGLE SLOT that player.lua drained. Writing `chest:put:`
  //      while `chest:open` is still sitting there unconsumed DESTROYS the open.
  // That is what this scenario kept hitting, intermittently and in both suite and solo runs:
  // the chest read ABSENT (no watch was ever armed) while the item itself moved perfectly --
  // A held 0 afterwards -- because only the SECOND of the two commands ever ran. It looked
  // like a broken container mirror and it was a clobbered command.
  await a.waitFor(
    `Object.prototype.hasOwnProperty.call(JSON.parse(window.omw.state.containerItems||"{}"), "n:${netId}")`,
    STEP_TIMEOUT,
    'the chest to REGISTER in containerItems after open (still absent = ContainerOpen never '
    + 'landed, so nothing was ever watching and the put was always going to be invisible)');
  await a.eval(`window.omw.send('chest:put:${itemId}')`);
  const chestHas = (n) =>
    `(JSON.parse(window.omw.state.containerItems||"{}")["n:${netId}"]||{})[${JSON.stringify(itemId)}] === ${n}`
    + (n === 0 ? ` || !((JSON.parse(window.omw.state.containerItems||"{}")["n:${netId}"]||{})[${JSON.stringify(itemId)}])` : '');
  // DID THE ITEM ACTUALLY LEAVE A'S INVENTORY? This split matters and nothing was measuring
  // it. mpChestPut walks the inventory for a matching recordId and calls moveInto, then returns
  // SILENTLY if the chest is missing or the item is not found -- so a failure here has two very
  // different causes and they need opposite fixes:
  //
  //   still in inventory -> the transfer never happened (moveInto no-op, or the silent return;
  //                         note this scenario puts an EQUIPPED item, which is a candidate)
  //   gone from inventory -> the transfer worked and the MIRROR is not reflecting it
  //
  // count:<id> already exists as a harness command and publishes to the `count` mirror, so this
  // costs nothing and needs no engine change.
  await ctx.sleep(1500);
  await a.eval("if (window.omw.state) window.omw.state.count = null; 'cleared';");
  await a.eval(`window.omw.send('count:${itemId}')`);
  await a.waitFor("typeof window.omw.state.count === 'string'", 10_000, 'A reported its count');
  const stillHeld = await a.eval('window.omw.state.count');
  ctx.log(`  after the put, A still holds ${stillHeld} of the item`
    + ' (0 = it moved and the mirror is at fault; 1 = the transfer never happened)');
  await a.waitFor(chestHas(1), STEP_TIMEOUT, 'chest holds 1 item on A');
  // B opens too (nil contents; the server already has canonical state) -> gets ContainerState.
  await b.eval(`window.omw.send('chest:open:${netId}')`);
  await b.waitFor(chestHas(1), STEP_TIMEOUT, 'chest state synced to B');
  ctx.log('ok: canonical chest state on both clients');

  // The race: both take the single item as simultaneously as the harness can manage.
  await Promise.all([
    a.eval(`window.omw.send('chesttake::${itemId}')`),
    b.eval(`window.omw.send('chesttake:${netId}:${itemId}')`),
  ]);
  await a.waitFor('!!window.omw.state.chestOp', STEP_TIMEOUT, 'A got an op result');
  await b.waitFor('!!window.omw.state.chestOp', STEP_TIMEOUT, 'B got an op result');
  const opA = JSON.parse(await a.eval('window.omw.state.chestOp'));
  const opB = JSON.parse(await b.eval('window.omw.state.chestOp'));
  ctx.log(`race results: A ok=${opA.ok} (${opA.reason ?? ''}), B ok=${opB.ok} (${opB.reason ?? ''})`);
  assert.equal([opA, opB].filter((o) => o.ok).length, 1, 'exactly ONE take must win');

  // Conservation: the canonical chest count is 0 on both — the item was taken once.
  await a.waitFor(chestHas(0), STEP_TIMEOUT, 'chest empty on A');
  await b.waitFor(chestHas(0), STEP_TIMEOUT, 'chest empty on B');
  ctx.log('ok: no duplication — chest 1 -> 0, single winner');
}
