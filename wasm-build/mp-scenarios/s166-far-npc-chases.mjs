// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s166: A FAR CREATURE CHASES. Every AI walk on the peer (wander, chase, pursue, follow,
// escort, travel, cast) goes through AiPackage::pathTo, whose "near an inactive cell" gate
// converted the actor's position into the PEER'S OWN DUMMY's cell frame and zeroed the
// movement past its 3x3 (backlog 285): with the dummy in Seyda Neen (-2,-9), every actor
// two cells north stood still -- a provoked creature glared at the avatar and never closed.
// The gate now asks the actor's own cell against the anchor-aware active grids. So: A holds
// the anchor at Seyda Neen, B stands in -2,-7 (s120's FAR), provokes a creature with one 1-point
// relay sting (s138/s164's idiom -- a real Fire Bite kills the 8-health scrib the peer rolls
// here) and retreats 450 units; the creature must
// close to melee reach within 15 s.
import assert from 'node:assert/strict';

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

  // Provoke it with ONE STING, not a spell that kills it. A Fire Bite is 15-30 damage and the
  // mark the peer rolls here is a scrib with 8 health: #106 killed it with the provocation
  // (world.kill "scrib") and then measured the chase of a corpse -- the gap came back Infinity,
  // which is not JSON, so the scenario read NaN. s138/s164 provoke the same way: a 1-point
  // relay sting, which cannot kill anything and still makes the creature come at you. The
  // chase is what this scenario is about; the cast path is s59's and s166 need not re-prove it.
  const p0 = await probeOf(b, victim);
  await b.cmd(`snapto:${Math.round(p0.x + 60)},${Math.round(p0.y)},${Math.round(p0.z + 8)}`);
  await b.eval("if (window.omw.state) window.omw.state.selfDivergence = null; 'cleared';");
  await b.waitFor('typeof window.omw.state.selfDivergence === "string" && Number(window.omw.state.selfDivergence) < 96', 60_000, 'the avatar rules our pose beside the mark');
  let hurt = false;
  for (let stings = 0; stings < 4 && !hurt; stings++) {
    await b.cmd(`hitn:${victim}:1`);
    await ctx.sleep(2_000);
    const q = await probeOf(b, victim);
    hurt = !!q && Number(q.hp) < Number(p0.hp);
  }
  const stung = await probeOf(b, victim);
  ctx.log(`the mark: the peer's "${victim}" hp ${p0.hp} -> ${(stung || {}).hp} (hurt=${hurt}); B retreats ${RETREAT} u`);
  assert.ok(hurt, `the ${victim} was never hurt by the sting; nothing to provoke a chase with`);
  assert.ok(stung && !stung.dead && Number(stung.hp) > 0, `the sting killed the ${victim} (${JSON.stringify(stung)}); a corpse cannot chase`);

  // Retreat: 450 u east of the creature, and the chase must close the gap.
  const p1 = (await probeOf(b, victim)) || p0;
  await b.cmd(`snapto:${Math.round(p1.x + RETREAT)},${Math.round(p1.y)},${Math.round(p1.z + 8)}`);
  await ctx.sleep(2_500);
  // -1, NOT Infinity: the eval crosses as JSON, where Infinity is not a value -- a dead or
  // absent mark came back as NaN and every message about it read "NaN u" (#106).
  const gapExpr = `(function(){const p=JSON.parse(window.omw.state.actorProbe||"{}")[${JSON.stringify(victim)}];const m=JSON.parse(window.omw.state.pose||"{}");return p&&!p.dead&&m.x!==undefined?Math.hypot(p.x-m.x,p.y-m.y):-1;})()`;
  const gap0 = Number(await b.eval(gapExpr));
  ctx.log(`gap after the retreat: ${gap0.toFixed(0)} u`);
  assert.ok(gap0 >= 400, `the retreat did not open the gap (${gap0.toFixed(0)} u; -1 = the mark is gone or dead); the chase would prove nothing`);
  const deadline = Date.now() + 15_000;
  let gap = gap0;
  while (Date.now() < deadline && gap >= CLOSE) { // -1 (dead/gone) ends the wait too
    await ctx.sleep(500);
    gap = Number(await b.eval(gapExpr));
  }
  ctx.log(`gap after the chase window: ${gap.toFixed(0)} u (probe=${JSON.stringify(await probeOf(b, victim))})`);
  assert.ok(gap >= 0 && gap < CLOSE, `the ${victim} never closed from ${gap0.toFixed(0)} to ${CLOSE} u in 15 s (${gap.toFixed(0)}; -1 = it died or left the probe): the peer's AI is frozen two cells from its dummy (pathTo's inactive-cell gate)`);
  ctx.log(`PASS: the peer's ${victim} chased the avatar ${gap0.toFixed(0)} -> ${gap.toFixed(0)} u two cells from the dummy`);
}
