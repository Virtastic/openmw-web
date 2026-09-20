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
import { goToCompanion } from './_companion.mjs';

// THE SERVER'S OWN PEER: only the production lifecycle anchors an INTERIOR (s118). With a
// hand-started peer the tradehouse had no holder and door:enter teleported by hook
// (backlog 243) -- nothing here proved the room was simulated.
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
  const [pa, pb] = await Promise.all([probeOf(a), probeOf(b)]);
  // An NPC, not a creature: the probe does not say which is which, so exclude the Seyda Neen
  // wildlife by name; a mudcrab at the water's edge is not a companion anybody recruits.
  const rec = Object.keys(pa).find((r) => r !== 'player' && pb[r] && !pa[r].dead && !pa[r].guard && !/mudcrab|scrib|rat|slaughterfish|kwama|cliff/.test(r));
  assert.ok(rec, 'need a living NPC visible to both clients');
  const start = pa[rec];

  // Recruit beside them, in a conversation (s114: #363 admits the claim only under the lock).
  await a.cmd(`snapto:${Math.round(start.x + 80)},${Math.round(start.y)},${Math.round(start.z + 8)}`);
  await ctx.sleep(4_000);
  // The NPC has to be an active actor here first (s114, #130), and the lock is the whole
  // point (#363): wait for the server's grant rather than a guessed 1.5 s; ask again if the
  // engine says the NPC is not there yet.
  await a.waitFor(`Object.prototype.hasOwnProperty.call(JSON.parse(window.omw.state.actorProbe||"{}"), ${JSON.stringify(rec)})`, 60_000, `"${rec}" is an active actor on A's client`);
  for (let attempt = 1; ; attempt++) {
    await a.cmd(`dlg:${rec}`);
    const granted = await a.waitFor('/"granted":true/.test(window.omw.state.dialogueLock||"")', 15_000, `the dialogue lock on "${rec}" was granted`).then(() => true).catch(() => false);
    if (granted) break;
    const mirror = await a.eval('window.omw.state.dialogueLock');
    if (attempt >= 3) throw new Error(`the dialogue lock on "${rec}" was never granted (mirror: ${mirror})`);
    ctx.log(`  no lock yet (mirror: ${mirror}); asking again`);
    await ctx.sleep(3_000);
  }
  await ctx.sleep(500);
  await a.cmd(`follow:${rec}`);
  await a.cmd('dlg:release');
  await ctx.sleep(3_000);
  ctx.log(`A recruited "${rec}" (claim=${await a.eval('window.omw.state.followClaim')})`);
  // The pre-dialogue probe was stale on a slow client (s114, #113: the peer had the NPC 1081 u
  // from the avatar, outside AiFollow's activation and global.lua's FOLLOW_RANGE at the door).
  // Now that the claim holds the NPC still, go and stand beside them for real. B follows
  // A's door from the same spot, so it is the door nearest THIS position that both take.
  const beside = await goToCompanion(ctx, a, rec, start);

  // Through the nearest load door.
  const outside = await cellOf(a);
  await a.cmd('door:enter');
  await ctx.sleep(1_000);
  ctx.log(`A door:enter -> ${await a.eval('window.omw.state.doorEnter')} (cell before: ${outside})`);
  await a.waitFor(`String(window.omw.state.cell||"") !== ${JSON.stringify(outside)}`, STEP, 'A changed cell through the door');
  const inside = await cellOf(a);
  ctx.log(`A went ${outside} -> ${inside} via ${await a.eval('window.omw.state.doorEnter')}`);
  // The room is SIMULATED: the peer holds it and A does not (s118's idiom). Without this a
  // companion "inside" is A's own unsimulated copy.
  await a.waitFor('String(window.omw.state.authorityHolder||"none") !== "none"', 120_000, 'the interior has a holder');
  await a.waitFor('window.omw.state.isHolder === "false"', STEP, 'A does not hold it (the peer does)');
  ctx.log(`the interior is held by ${await a.eval('window.omw.state.authorityHolder')}`);
  await a.waitFor(`Object.prototype.hasOwnProperty.call(JSON.parse(window.omw.state.actorProbe||"{}"), ${JSON.stringify(rec)})`, 60_000,
    `A's companion "${rec}" is in the interior with A`);

  // The friend follows through the same door and finds them both.
  await b.cmd(`snapto:${Math.round(beside.x + 80)},${Math.round(beside.y)},${Math.round(beside.z + 8)}`);
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
