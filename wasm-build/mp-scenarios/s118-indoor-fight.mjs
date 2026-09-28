// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s118: A FIGHT INDOORS. s51 proves shared NPC combat under the open sky, where the peer's
// avatar stands in the cell it simulates. An interior is different: it has no grid
// coordinate, so the peer holds it as a ROOM anchor (MP_SimAnchors) -- loaded and ticked
// without the peer's own body inside -- and every relay addresses it by name. Two players walk
// through the same door, both hit the same NPC, and it dies once, for both.
import assert from 'node:assert/strict';
import { focus, armMelee, swingUntil, probeOf as probeRec } from './_realfight.mjs';
import { pickUntil } from './_probe.mjs';

// WHERE YOU FELL, not the harness's Example Suite village (26,25): that point is open sea in
// retail, and a player the mark killed respawned among slaughterfish and swung at nothing for
// the rest of the fight (#159 s118: the mark 52 -> 32, then 'none within 400').
export const serverRules = 'respawnCellKey = ""';

// A shopkeeper behind his counter cannot be walked up to: the real fight stalled at the counter
// and swung from where the snap landed (#157, Arrille). A customer on the shop floor is the mark.
const BEHIND_COUNTER = /^arrille$/;

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

  // A BIGGER POOL, as s149 does: a level-1 character does not outlast a summoner (#172: Tolvise
  // and her skeleton killed both players mid-fight). +60 is the largest raise the server allows.
  for (const c of [a, b]) {
    const b0 = String(await c.eval('window.omw.state.selfStats') || '0/0').split('/').map(Number);
    await c.cmd(`sethpbase:${b0[1] + 60}`);
    await c.waitFor(`Number(String(window.omw.state.selfStats||"0/0").split("/")[1]) >= ${b0[1] + 58}`, STEP, `${c.name}'s max rose`);
    await c.cmd(`sethp:${b0[1] + 60}`);
    await c.waitFor(`Number(String(window.omw.state.selfStats||"0/0").split("/")[0]) >= ${b0[1] + 50}`, STEP, `${c.name}'s pool filled`);
  }

  let pa, pb, victim;
  // ON THE SAME FLOOR: an NPC upstairs is a walk up a staircase the fight helper does not path
  // (#158: Hrisskar, 440 u short of him at every approach).
  const floorZ = JSON.parse(await a.eval('window.omw.state.pose||"{}"')).z;
  ({ found: victim, probes: [pa, pb] } = await pickUntil(ctx, () => Promise.all([probeOf(a), probeOf(b)]), (pa, pb) => Object.keys(pa).find((r) => r !== 'player' && pb[r] && !pa[r].dead && !pa[r].guard && !BEHIND_COUNTER.test(r)
    && !(Number.isFinite(floorZ) && Math.abs(pa[r].z - floorZ) > 150))));
  assert.ok(victim, `need a living NPC inside visible to both: A=${JSON.stringify(Object.keys(pa))} B=${JSON.stringify(Object.keys(pb))}`);
  ctx.log(`both attacking "${victim}" indoors (holder=${await a.eval('window.omw.state.authorityHolder')})`);

  const deadExpr = `((JSON.parse(window.omw.state.actorProbe||"{}")[${JSON.stringify(victim)}]||{}).dead === true)`;
  // FOR REAL, both players at once: W to walk up, the mouse button to swing (_realfight.mjs).
  for (const c of [a, b]) { await focus(c); await armMelee(c); }
  const isDead = async () => (await a.eval(deadExpr)) === true || (await b.eval(deadExpr)) === true;
  const fights = await Promise.all([a, b].map((c, i) => swingUntil(ctx, c, () => probeRec(c, victim), isDead, { budgetMs: 240_000, side: i * Math.PI })));
  ctx.log(`real swings: A ${fights[0].swings}, B ${fights[1].swings}`);
  const died = await isDead();
  ctx.log(`hitFwd A=${await a.eval('window.omw.state.hitFwd')} B=${await b.eval('window.omw.state.hitFwd')}`);
  assert.ok(died, `"${victim}" never died indoors: hits are not reaching the room's holder, or the peer does not simulate the room`);
  await a.waitFor(deadExpr, STEP, 'A sees it dead');
  await b.waitFor(deadExpr, STEP, 'B sees it dead');
  ctx.log(`ok: "${victim}" died once indoors, for both players`);
}
