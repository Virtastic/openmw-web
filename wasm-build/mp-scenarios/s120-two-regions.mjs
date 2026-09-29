// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s120: TWO PLAYERS, TWO PLACES, ONE PEER. Friends do not stay in one cell. The world peer
// simulates every occupied cell through its anchor list (MP_SimAnchors; the engine's 7168-unit
// processing clamp is lifted per anchor), so A fighting in Seyda Neen and B fighting two cells
// north must BOTH see their NPC die. Before the anchor design a peer simulated the one cell
// it stood in and everyone else fought statues.
import assert from 'node:assert/strict';
import { focus, armMelee, swingUntil, probeOf as probeRec } from './_realfight.mjs';
import { pickUntil } from './_probe.mjs';

export const managedPeer = true;
const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const FAR = '-12500,-53100,512'; // -2,-7 (s109), two cells from Seyda Neen (-2,-9)
const probeOf = async (c) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'));
const holderOf = async (c) => String(await c.eval('window.omw.state.authorityHolder||"none"'));

async function killOne(ctx, c, victim, label) {
  const deadExpr = `((JSON.parse(window.omw.state.actorProbe||"{}")[${JSON.stringify(victim)}]||{}).dead === true)`;
  // FOR REAL: W to walk up, the mouse button to swing (_realfight.mjs).
  await focus(c); await armMelee(c);
  const fight = await swingUntil(ctx, c, () => probeRec(c, victim), async () => (await c.eval(deadExpr)) === true, { budgetMs: 240_000 });
  const died = fight.done;
  ctx.log(`${label}: ${fight.swings} real swing(s)`);
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

  // A VICTIM A PLAYER COULD ACTUALLY FIGHT: alone under its record id and within REACH of the
  // client. hitn and the probe both key by record, so with two of a kind the scenario hit one
  // and watched the other -- #147: the peer logged the kwama forager it was hitting at hp=0
  // dead=true a cell away while the probe's forager, beside B, stayed alive. hitn now takes the
  // nearest match (global.lua mpTestHit); this keeps the pick to one a real swing would reach.
  const REACH = 3000;
  const poseOf = async (c) => JSON.parse(await c.eval('window.omw.state.pose||"null"'));
  const [ma, mb] = [await poseOf(a), await poseOf(b)];
  const near = (q, me, r) => !me || Math.hypot(q[r].x - me.x, q[r].y - me.y) <= REACH;
  const pick = (q, me, ok) => Object.keys(q)
    .filter((r) => r !== 'player' && !q[r].dead && (q[r].n ?? 1) === 1 && near(q, me, r) && ok(r))
    .sort((r1, r2) => (me ? Math.hypot(q[r1].x - me.x, q[r1].y - me.y) - Math.hypot(q[r2].x - me.x, q[r2].y - me.y) : 0))[0];
  let pa, pb, va, vb;
  await pickUntil(ctx, () => Promise.all([probeOf(a), probeOf(b)]), (qa, qb) => {
    pa = qa; pb = qb;
    // Dockside NPCs excluded too: vodunius nuccius stands over Seyda Neen's water, and a real
    // chase/swing loop can walk A off the pier into it (#178) -- what killed A there was a
    // slaughterfish plus drowning, not the fight itself, 35 real swings into an unrelated target.
    // A land creature first, a named NPC only when there is none: a named NPC in a guarded town makes the fight
    // a crime (PlayerCrime/PlayerArrest, an arrest dialogue on A's client, no use bit while a menu is open)
    // and five builds went red on it (#175-#181). Never a fish (the swinger drowns) or a dockside NPC.
    // ANY creature in A's loaded grid, not only one within REACH of where A stands: the swing loop walks
    // or snaps beside the mark (_realfight.mjs), and Seyda Neen's centre has none within 3000 u -- so the
    // reach-limited pick fell through to a named NPC every time (#184: eldafire, bounty 40, arrested,
    // twice red). The anchored regex: an unanchored /rat/ matched 'indrele rathryon' (#182).
    const creatureRe = /^(mudcrab|scrib|rat|kwama .*|guar|alit|cliff racer|kagouti|nix-hound|shalk)$/i;
    const nearestCreature = Object.keys(pa)
      .filter((r) => r !== 'player' && !pa[r].dead && !pa[r].guard && (pa[r].n ?? 1) === 1 && creatureRe.test(r))
      .sort((r1, r2) => (ma ? Math.hypot(pa[r1].x - ma.x, pa[r1].y - ma.y) - Math.hypot(pa[r2].x - ma.x, pa[r2].y - ma.y) : 0))[0];
    // ...a duplicated creature record before any NPC (a crime is worse than an ambiguous probe row).
    const dupCreature = Object.keys(pa).filter((r) => !pa[r].dead && !pa[r].guard && creatureRe.test(r))
      .sort((r1, r2) => (ma ? Math.hypot(pa[r1].x - ma.x, pa[r1].y - ma.y) - Math.hypot(pa[r2].x - ma.x, pa[r2].y - ma.y) : 0))[0];
    va = nearestCreature
      ?? dupCreature
      ?? pick(pa, ma, (r) => !pa[r].guard && !/mudcrab|scrib|rat|slaughterfish|kwama|vodunius nuccius/.test(r));
    // Any live actor as the last resort, duplicates and distance allowed (#185: B's cell held only 'rat's,
    // n > 1, so the unique-within-reach pick found nothing and the scenario died on its own precondition).
    const anyLive = (q, me) => Object.keys(q).filter((r) => r !== 'player' && !q[r].dead && !q[r].guard)
      .sort((r1, r2) => (me ? Math.hypot(q[r1].x - me.x, q[r1].y - me.y) - Math.hypot(q[r2].x - me.x, q[r2].y - me.y) : 0))[0];
    vb = pick(pb, mb, () => true) ?? anyLive(pb, mb);
    return va && vb;
  });
  assert.ok(va && vb, `need a living actor in each cell: A=${JSON.stringify(Object.keys(pa))} B=${JSON.stringify(Object.keys(pb))}`);

  const [da, db] = await Promise.all([killOne(ctx, a, va, 'A in Seyda Neen'), killOne(ctx, b, vb, 'B two cells north')]);
  assert.ok(da, `A's fight did not resolve: the peer is not simulating A's cell`);
  assert.ok(db, `B's fight did not resolve: the peer is not simulating B's cell (the second anchor)`);
  ctx.log('ok: one peer simulated both occupied cells; both fights resolved');
}
