// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s31 (M3): container transactionality. A spawns a chest (net-addressed; B holds a
// placeholder object but the container STATE syncs), puts one item in, both clients open
// it, then both race a take of the SAME single item. The server is the serialization
// point: exactly one ContainerOpResult ok=true, and the canonical chest inventory drops
// 1 -> 0 with no duplication (conservation at the source of truth).
import assert from 'node:assert/strict';

const STEP_TIMEOUT = 15_000;

export default async function run(ctx) {
  const [a, b] = await Promise.all([
    ctx.launchClient('bot-a'),
    ctx.launchClient('bot-b'),
  ]);

  await a.eval(`Module.__omwMPCmd='equiptest'`);
  await a.waitFor('((window.__omwMP||{}).equippedIds||"") !== ""', 12_000, 'A holds the test item');
  const itemId = (await a.eval('(window.__omwMP||{}).equippedIds')).split(',')[0];

  await a.eval(`Module.__omwMPCmd='chest:spawn'`);
  await a.waitFor('Object.keys(JSON.parse((window.__omwMP||{}).netObjects||"{}")).length === 1',
    STEP_TIMEOUT, 'chest netted on A');
  const netId = await a.eval('Object.keys(JSON.parse(window.__omwMP.netObjects))[0]');
  await b.waitFor(`!!JSON.parse((window.__omwMP||{}).netObjects||"{}")[${JSON.stringify(netId)}]`,
    STEP_TIMEOUT, 'chest placed on B');

  // A opens (registers canonical contents = empty), puts the item in.
  await a.eval(`Module.__omwMPCmd='chest:open'`);
  await ctx.sleep(500);
  await a.eval(`Module.__omwMPCmd='chest:put:${itemId}'`);
  const chestHas = (n) =>
    `(JSON.parse((window.__omwMP||{}).containerItems||"{}")["n:${netId}"]||{})[${JSON.stringify(itemId)}] === ${n}`
    + (n === 0 ? ` || !((JSON.parse((window.__omwMP||{}).containerItems||"{}")["n:${netId}"]||{})[${JSON.stringify(itemId)}])` : '');
  await a.waitFor(chestHas(1), STEP_TIMEOUT, 'chest holds 1 item on A');
  // B opens too (nil contents; the server already has canonical state) -> gets ContainerState.
  await b.eval(`Module.__omwMPCmd='chest:open:${netId}'`);
  await b.waitFor(chestHas(1), STEP_TIMEOUT, 'chest state synced to B');
  ctx.log('ok: canonical chest state on both clients');

  // The race: both take the single item as simultaneously as the harness can manage.
  await Promise.all([
    a.eval(`Module.__omwMPCmd='chesttake::${itemId}'`),
    b.eval(`Module.__omwMPCmd='chesttake:${netId}:${itemId}'`),
  ]);
  await a.waitFor('!!(window.__omwMP||{}).chestOp', STEP_TIMEOUT, 'A got an op result');
  await b.waitFor('!!(window.__omwMP||{}).chestOp', STEP_TIMEOUT, 'B got an op result');
  const opA = JSON.parse(await a.eval('window.__omwMP.chestOp'));
  const opB = JSON.parse(await b.eval('window.__omwMP.chestOp'));
  ctx.log(`race results: A ok=${opA.ok} (${opA.reason ?? ''}), B ok=${opB.ok} (${opB.reason ?? ''})`);
  assert.equal([opA, opB].filter((o) => o.ok).length, 1, 'exactly ONE take must win');

  // Conservation: the canonical chest count is 0 on both — the item was taken once.
  await a.waitFor(chestHas(0), STEP_TIMEOUT, 'chest empty on A');
  await b.waitFor(chestHas(0), STEP_TIMEOUT, 'chest empty on B');
  ctx.log('ok: no duplication — chest 1 -> 0, single winner');
}
