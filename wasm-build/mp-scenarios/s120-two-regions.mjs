// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s120: TWO PLAYERS, TWO PLACES, ONE PEER. Friends do not stay in one cell. The world peer
// simulates every occupied cell through its anchor list (MP_SimAnchors; the engine's 7168-unit
// processing clamp is lifted per anchor), so A fighting in Seyda Neen and B fighting two cells
// north must BOTH see their NPC die. Before the anchor design a peer simulated the one cell
// it stood in and everyone else fought statues.
import assert from 'node:assert/strict';

export const managedPeer = true;
const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const FAR = '-12500,-53100,512'; // -2,-7 (s109), two cells from Seyda Neen (-2,-9)
const probeOf = async (c) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'));
const holderOf = async (c) => String(await c.eval('window.omw.state.authorityHolder||"none"'));

async function killOne(ctx, c, victim, label) {
  const deadExpr = `((JSON.parse(window.omw.state.actorProbe||"{}")[${JSON.stringify(victim)}]||{}).dead === true)`;
  const deadline = Date.now() + 90_000;
  let died = false;
  while (Date.now() < deadline && !died) {
    await c.cmd(`hitn:${victim}:60`);
    await ctx.sleep(600);
    died = (await c.eval(deadExpr)) === true;
  }
  ctx.log(`${label}: "${victim}" ${died ? 'died' : 'NEVER died'} (holder=${await holderOf(c)}, hitFwd=${await c.eval('window.omw.state.hitFwd')})`);
  return died;
}

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  for (const c of [a, b]) await c.waitFor('window.omw.state.state === "Joined"', 60_000, `${c.name} joined`);
  await b.cmd('snapto:' + FAR);
  await b.waitFor('String(window.omw.state.cell||"") === "-2,-7"', STEP, 'B stands two cells north');

  // Both cells get a holder that is not a client.
  for (const c of [a, b]) {
    await c.waitFor('String(window.omw.state.authorityHolder||"none") !== "none"', 300_000, `${c.name}'s cell has a holder`);
    await c.waitFor('window.omw.state.isHolder === "false"', STEP, `${c.name} does not hold it`);
    await c.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 120_000, `${c.name} puppets its cell's actors`);
  }
  ctx.log(`holders: A's cell=${await holderOf(a)} B's cell=${await holderOf(b)} (one peer, two anchors)`);

  const pa = await probeOf(a);
  const va = Object.keys(pa).find((r) => r !== 'player' && !pa[r].dead && !pa[r].guard && !/mudcrab|scrib|rat|slaughterfish|kwama/.test(r));
  const pb = await probeOf(b);
  const vb = Object.keys(pb).find((r) => r !== 'player' && !pb[r].dead);
  assert.ok(va && vb, `need a living actor in each cell: A=${JSON.stringify(Object.keys(pa))} B=${JSON.stringify(Object.keys(pb))}`);

  const [da, db] = await Promise.all([killOne(ctx, a, va, 'A in Seyda Neen'), killOne(ctx, b, vb, 'B two cells north')]);
  assert.ok(da, `A's fight did not resolve: the peer is not simulating A's cell`);
  assert.ok(db, `B's fight did not resolve: the peer is not simulating B's cell (the second anchor)`);
  ctx.log('ok: one peer simulated both occupied cells; both fights resolved');
}
