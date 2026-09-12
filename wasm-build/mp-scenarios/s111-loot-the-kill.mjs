// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s111: LOOT THE KILL. After the fight (s109) comes the corpse. Every client holds its own
// copy of a peer-named creature's inventory (each engine rolled it from the record), so the
// corpse is a shared container exactly like a chest: the first opener's snapshot becomes
// canonical, every later opener receives it, and a take is a server transaction that ONE
// player wins. Without that, two players looting the same kill each walk away with the loot.
//
// The creature is addressed by NET ID at every hop (it has no content ref), which is the new
// thing here over s31's chest.
import assert from 'node:assert/strict';

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const SPOT = '-12500,-53100,512';

const netObjs = async (c) => JSON.parse(await c.eval('window.omw.state.netObjects||"{}"'));
const corpseHas = (netId, itemId, n) =>
  `(JSON.parse(window.omw.state.containerItems||"{}")["n:${netId}"]||{})[${JSON.stringify(itemId)}] === ${n}`
  + (n === 0 ? ` || !((JSON.parse(window.omw.state.containerItems||"{}")["n:${netId}"]||{})[${JSON.stringify(itemId)}])` : '');

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-7');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  await a.cmd('snapto:' + SPOT);
  await b.cmd('snapto:' + SPOT);
  await a.waitFor('Object.keys(JSON.parse(window.omw.state.netObjects||"{}")).length > 0', 120_000, 'A built a named creature');
  await b.waitFor('Object.keys(JSON.parse(window.omw.state.netObjects||"{}")).length > 0', 120_000, 'B built a named creature');
  const oa = await netObjs(a), ob = await netObjs(b);
  const netId = Object.keys(oa).find((id) => ob[id] === oa[id]);
  assert.ok(netId, 'no creature both clients agree on');
  const victim = oa[netId];
  for (const c of [a, b]) await c.waitFor('Number(window.omw.state.puppetedActors||0) > 0', STEP, `${c.name} puppeted the cell actors`);

  // Kill it (the s109 chain).
  const deadExpr = `((JSON.parse(window.omw.state.actorProbe||"{}")[${JSON.stringify(victim)}]||{}).dead === true)`;
  const deadline = Date.now() + 90_000;
  let died = false;
  while (Date.now() < deadline && !died) {
    await a.cmd(`hitn:${victim}:40`);
    await ctx.sleep(600);
    died = (await a.eval(deadExpr)) === true;
  }
  assert.ok(died, `the ${victim} never died (s109 covers this)`);
  await b.waitFor(deadExpr, STEP, 'B sees it dead');
  ctx.log(`the peer's "${victim}" (net ${netId}) is dead on both screens; looting`);

  // A opens the corpse and puts one item in it, so there is something definite to race for
  // (a creature's own roll may be empty). The put is the same watch-diff path the UI takes.
  await a.cmd('equiptest');
  await a.waitFor('(window.omw.state.equippedIds||"") !== ""', 12_000, 'A holds the test item');
  const itemId = (await a.eval('window.omw.state.equippedIds')).split(',')[0];
  await a.cmd(`chest:open:${netId}`);
  await a.waitFor(`Object.prototype.hasOwnProperty.call(JSON.parse(window.omw.state.containerItems||"{}"), "n:${netId}")`,
    STEP, 'the corpse registered as a shared container on A (ContainerOpen by net id)');
  await a.cmd(`chest:put:${itemId}`);
  await a.waitFor(corpseHas(netId, itemId, 1), STEP, 'the corpse holds the item on A');

  // B opens: receives the canonical contents, including A's item.
  await b.cmd(`chest:open:${netId}`);
  await b.waitFor(corpseHas(netId, itemId, 1), STEP, 'the corpse state synced to B');
  ctx.log('ok: canonical corpse contents on both clients');

  // Both grab it: one winner, corpse empty everywhere.
  await Promise.all([a.cmd(`chesttake:${netId}:${itemId}`), b.cmd(`chesttake:${netId}:${itemId}`)]);
  await a.waitFor('!!window.omw.state.chestOp', STEP, 'A got an op result');
  await b.waitFor('!!window.omw.state.chestOp', STEP, 'B got an op result');
  const opA = JSON.parse(await a.eval('window.omw.state.chestOp'));
  const opB = JSON.parse(await b.eval('window.omw.state.chestOp'));
  ctx.log(`race: A ok=${opA.ok} (${opA.reason ?? ''}), B ok=${opB.ok} (${opB.reason ?? ''})`);
  assert.equal([opA, opB].filter((o) => o.ok).length, 1, 'exactly ONE take must win');
  await a.waitFor(corpseHas(netId, itemId, 0), STEP, 'corpse empty on A');
  await b.waitFor(corpseHas(netId, itemId, 0), STEP, 'corpse empty on B');
  const errs = a.luaErrors().concat(b.luaErrors());
  assert.equal(errs.length, 0, 'Lua errors while looting:\n' + errs.join('\n'));
  ctx.log('ok: the kill was looted once, by one player');
}
