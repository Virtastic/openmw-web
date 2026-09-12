// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s118: A FIGHT INDOORS. s51 proves shared NPC combat under the open sky, where the peer's
// avatar stands in the cell it simulates. An interior is different: it has no grid
// coordinate, so the peer holds it as a ROOM anchor (MP_SimAnchors) -- loaded and ticked
// without the peer's own body inside -- and every relay addresses it by name. Two players walk
// through the same door, both hit the same NPC, and it dies once, for both.
import assert from 'node:assert/strict';

// THE SERVER'S OWN PEER. A hand-spawned peer stands in one exterior cell and never anchors a
// room; only the production lifecycle (server.ts simPeerPass -> SimAnchors interiors) holds an
// interior, so this is the first scenario to run it. (Found by this scenario: with the
// hand-spawned peer the tradehouse never had a holder at all.)
export const managedPeer = true;
const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const probeOf = async (c) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'));
const cellOf = async (c) => String(await c.eval('window.omw.state.cell||""'));

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  for (const c of [a, b]) await c.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 300_000, `${c.name} puppeted the cell actors`);
  const outside = await cellOf(a);
  for (const c of [a, b]) {
    await c.cmd('door:enter');
    await c.waitFor(`String(window.omw.state.cell||"") !== ${JSON.stringify(outside)}`, STEP, `${c.name} went through the door`);
  }
  const inside = await cellOf(a);
  assert.equal(await cellOf(b), inside, 'both are in the same interior');
  ctx.log(`both inside "${inside}"`);

  // The room is simulated: somebody holds it and both puppet its actors.
  for (const c of [a, b]) {
    await c.waitFor('String(window.omw.state.authorityHolder||"none") !== "none"', 120_000, `${c.name}: the interior has a holder`);
    await c.waitFor('window.omw.state.isHolder === "false"', STEP, `${c.name} does not hold it (the peer does)`);
  }
  const [pa, pb] = await Promise.all([probeOf(a), probeOf(b)]);
  const victim = Object.keys(pa).find((r) => r !== 'player' && pb[r] && !pa[r].dead && !pa[r].guard);
  assert.ok(victim, `need a living NPC inside visible to both: A=${JSON.stringify(Object.keys(pa))} B=${JSON.stringify(Object.keys(pb))}`);
  ctx.log(`both attacking "${victim}" indoors (holder=${await a.eval('window.omw.state.authorityHolder')})`);

  const deadExpr = `((JSON.parse(window.omw.state.actorProbe||"{}")[${JSON.stringify(victim)}]||{}).dead === true)`;
  const deadline = Date.now() + 90_000;
  let died = false;
  while (Date.now() < deadline && !died) {
    await a.cmd(`hitn:${victim}:40`);
    await b.cmd(`hitn:${victim}:40`);
    await ctx.sleep(600);
    died = (await a.eval(deadExpr)) === true || (await b.eval(deadExpr)) === true;
  }
  ctx.log(`hitFwd A=${await a.eval('window.omw.state.hitFwd')} B=${await b.eval('window.omw.state.hitFwd')}`);
  assert.ok(died, `"${victim}" never died indoors: hits are not reaching the room's holder, or the peer does not simulate the room`);
  await a.waitFor(deadExpr, STEP, 'A sees it dead');
  await b.waitFor(deadExpr, STEP, 'B sees it dead');
  ctx.log(`ok: "${victim}" died once indoors, for both players`);
}
