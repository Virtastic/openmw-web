// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s117: A COMPANION COMES INDOORS WITH YOU, AND YOUR FRIEND FINDS YOU BOTH THERE. The engine
// carries a follower through a load door only when it follows a PLAYER; on the peer the target
// is an avatar, so global.lua's MP_PlayerCellChange moves followers along with the avatar.
// Then the friend walks through the same door: the interior is simulated by the peer for
// the players in it, and the companion must be standing there on the friend's screen too.
// The whole "let's go into the shop together" beat -- one of the commonest things two people
// do -- in one scenario.
import assert from 'node:assert/strict';

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const probeOf = async (c) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'));
const cellOf = async (c) => String(await c.eval('window.omw.state.cell||""'));

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  for (const c of [a, b]) await c.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 300_000, `${c.name} puppeted the cell actors`);
  const [pa, pb] = await Promise.all([probeOf(a), probeOf(b)]);
  const rec = Object.keys(pa).find((r) => r !== 'player' && pb[r] && !pa[r].dead && !pa[r].guard);
  assert.ok(rec, 'need a living NPC visible to both clients');
  const start = pa[rec];

  // Recruit beside them (s114).
  await a.cmd(`snapto:${Math.round(start.x + 80)},${Math.round(start.y)},${Math.round(start.z + 8)}`);
  await ctx.sleep(4_000);
  await a.cmd(`follow:${rec}`);
  await ctx.sleep(3_000);
  ctx.log(`A recruited "${rec}" (claim=${await a.eval('window.omw.state.followClaim')})`);

  // Through the nearest load door.
  const outside = await cellOf(a);
  await a.cmd('door:enter');
  await a.waitFor(`String(window.omw.state.cell||"") !== ${JSON.stringify(outside)}`, STEP, 'A changed cell through the door');
  const inside = await cellOf(a);
  ctx.log(`A went ${outside} -> ${inside} via ${await a.eval('window.omw.state.doorEnter')}`);
  await a.waitFor(`Object.prototype.hasOwnProperty.call(JSON.parse(window.omw.state.actorProbe||"{}"), ${JSON.stringify(rec)})`, 60_000,
    `A's companion "${rec}" is in the interior with A`);

  // The friend follows through the same door and finds them both.
  await b.cmd(`snapto:${Math.round(start.x + 80)},${Math.round(start.y)},${Math.round(start.z + 8)}`);
  await ctx.sleep(2_000);
  await b.cmd('door:enter');
  await b.waitFor(`String(window.omw.state.cell||"") === ${JSON.stringify(inside)}`, STEP, 'B entered the same interior');
  await b.waitFor(`Object.prototype.hasOwnProperty.call(JSON.parse(window.omw.state.actorProbe||"{}"), ${JSON.stringify(rec)})`, 60_000,
    `B sees the companion "${rec}" inside`);
  const qa = await probeOf(a), qb = await probeOf(b);
  const d = Math.hypot(qa[rec].x - qb[rec].x, qa[rec].y - qb[rec].y);
  ctx.log(`companion inside on both screens; positions differ by ${Math.round(d)} units`);
  assert.ok(d < 400, 'the companion stands somewhere else on B');
  ctx.log(`ok: "${rec}" came indoors with A, and B found them both there`);
}
