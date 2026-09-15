// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s166: A FAR CREATURE CHASES. Every AI walk on the peer (wander, chase, pursue, follow,
// escort, travel, cast) goes through AiPackage::pathTo, whose "near an inactive cell" gate
// converted the actor's position into the PEER'S OWN DUMMY's cell frame and zeroed the
// movement past its 3x3 (backlog 285): with the dummy in Seyda Neen (-2,-9), every actor
// two cells north stood still -- a provoked creature glared at the avatar and never closed.
// The gate now asks the actor's own cell against the anchor-aware active grids. So: A holds
// the anchor at Seyda Neen, B stands in -2,-7 (s120's FAR), provokes a creature with a real
// touch cast (_spell idiom; hitn: is test-only) and retreats 450 units; the creature must
// close to melee reach within 15 s.
import assert from 'node:assert/strict';
import { prepareCast, castAt, FIRE_BITE } from './_spell.mjs';

export const managedPeer = true;
const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const FAR = '-12500,-53100,512'; // -2,-7, two cells north of Seyda Neen (s120)
const RETREAT = 450; // >= 400 u away from the creature when the chase starts
const CLOSE = 150; // "reached": inside melee reach of the avatar

const netObjs = async (c) => JSON.parse(await c.eval('window.omw.state.netObjects||"{}"'));
const probeOf = async (c, rec) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'))[rec];
const poseOf = async (c) => JSON.parse(await c.eval('window.omw.state.pose||"{}"'));

export default async function run(ctx) {
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  for (const c of [a, b]) await c.waitFor('window.omw.state.state === "Joined"', 60_000, `${c.name} joined`);
  await b.cmd('snapto:' + FAR);
  await b.waitFor('String(window.omw.state.cell||"") === "-2,-7"', STEP, 'B stands two cells north');
  await b.waitFor('Object.keys(JSON.parse(window.omw.state.netObjects||"{}")).length > 0', 120_000, 'the peer named a creature in -2,-7');
  await b.waitFor('Number(window.omw.state.puppetedActors||0) > 0', STEP, 'the cell is puppeted (the peer holds it)');
  ctx.log(`A in ${await a.eval('window.omw.state.cell')} (the anchor the dummy stands by), B in ${await b.eval('window.omw.state.cell')}`);

  // The nearest living named creature (keyed by record, s164).
  const me = await poseOf(b);
  const probe = JSON.parse(await b.eval('window.omw.state.actorProbe||"{}"'));
  const dist = (r) => { const p = probe[r]; return p && !p.dead ? Math.hypot(p.x - me.x, p.y - me.y) : Infinity; };
  const victim = Object.values(await netObjs(b)).sort((x, y) => dist(x) - dist(y))[0];
  assert.ok(victim && Number.isFinite(dist(victim)), `no living named creature in the probe: ${JSON.stringify(Object.keys(probe))}`);

  // Provoke it for real: beside it, one Fire Bite on touch.
  const p0 = await probeOf(b, victim);
  await b.cmd(`snapto:${Math.round(p0.x + 60)},${Math.round(p0.y)},${Math.round(p0.z + 8)}`);
  await b.eval("if (window.omw.state) window.omw.state.selfDivergence = null; 'cleared';");
  await b.waitFor('typeof window.omw.state.selfDivergence === "string" && Number(window.omw.state.selfDivergence) < 96', 60_000, 'the avatar rules our pose beside the mark');
  await prepareCast(b, ctx, FIRE_BITE, 'destruction');
  let hurt = false;
  for (let casts = 0; casts < 6 && !hurt; casts++) {
    const p = (await probeOf(b, victim)) || p0;
    await castAt(b, ctx, p);
    const q = await probeOf(b, victim);
    hurt = !!q && Number(q.hp) < Number(p0.hp);
  }
  ctx.log(`the mark: the peer's "${victim}" hp ${p0.hp} -> ${(await probeOf(b, victim) || {}).hp} (hurt=${hurt}); B retreats ${RETREAT} u`);
  assert.ok(hurt, `the ${victim} was never hurt by a real touch cast; nothing to provoke a chase with`);

  // Retreat: 450 u east of the creature, and the chase must close the gap.
  const p1 = (await probeOf(b, victim)) || p0;
  await b.cmd(`snapto:${Math.round(p1.x + RETREAT)},${Math.round(p1.y)},${Math.round(p1.z + 8)}`);
  await ctx.sleep(2_500);
  const gapExpr = `(function(){const p=JSON.parse(window.omw.state.actorProbe||"{}")[${JSON.stringify(victim)}];const m=JSON.parse(window.omw.state.pose||"{}");return p&&!p.dead?Math.hypot(p.x-m.x,p.y-m.y):Infinity;})()`;
  const gap0 = Number(await b.eval(gapExpr));
  ctx.log(`gap after the retreat: ${gap0.toFixed(0)} u`);
  assert.ok(gap0 >= 400, `the retreat did not open the gap (${gap0.toFixed(0)} u); the chase would prove nothing`);
  const deadline = Date.now() + 15_000;
  let gap = gap0;
  while (Date.now() < deadline && gap >= CLOSE) {
    await ctx.sleep(500);
    gap = Number(await b.eval(gapExpr));
  }
  ctx.log(`gap after the chase window: ${gap.toFixed(0)} u (probe=${JSON.stringify(await probeOf(b, victim))})`);
  assert.ok(gap < CLOSE, `the ${victim} never closed from ${gap0.toFixed(0)} to ${CLOSE} u in 15 s: the peer's AI is frozen two cells from its dummy (pathTo's inactive-cell gate)`);
  ctx.log(`PASS: the peer's ${victim} chased the avatar ${gap0.toFixed(0)} -> ${gap.toFixed(0)} u two cells from the dummy`);
}
