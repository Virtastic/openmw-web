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
  // THE PROBE IS A MIRROR, NOT A READ. actorProbe is rewritten on actors.lua's tick from the
  // own cell's actors; `netObjects > 0` is true the moment the peer's spawn is netted, a tick
  // or a cell change before the probe lists it (#111 s164: "no living named creature in the
  // probe: []" with three scribs netted in -2,-7). Wait for a living netted record IN the probe.
  await b.waitFor(`(function(){var pr=JSON.parse(window.omw.state.actorProbe||"{}");return Object.values(JSON.parse(window.omw.state.netObjects||"{}")).some(function(r){var p=pr[r];return p&&!p.dead;});})()`,
    STEP, 'the peer\'s creature is in the probe, alive');

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
  // READ THE GAP THE MOMENT THE SNAP LANDS. The mark is already provoked and a rat covers
  // 200+ u in the 2.5 s this used to sleep (#107 104 u, #111 227 u: "the retreat did not open
  // the gap" -- it had, and the chase under test had already eaten it). The pose mirror is
  // 2 Hz; poll it until the snap shows, then measure.
  await b.waitFor(`Math.abs((JSON.parse(window.omw.state.pose||"{}").x||0) - ${Math.round(p1.x + RETREAT)}) < 64`, 10_000, 'the pose mirror shows the retreat');
  // -1, NOT Infinity: the eval crosses as JSON, where Infinity is not a value -- a dead or
  // absent mark came back as NaN and every message about it read "NaN u" (#106).
  const gapExpr = `(function(){const p=JSON.parse(window.omw.state.actorProbe||"{}")[${JSON.stringify(victim)}];const m=JSON.parse(window.omw.state.pose||"{}");return p&&!p.dead&&m.x!==undefined?Math.hypot(p.x-m.x,p.y-m.y):-1;})()`;
  const gap0 = Number(await b.eval(gapExpr));
  ctx.log(`gap after the retreat: ${gap0.toFixed(0)} u`);
  // The retreat is the setup: it must leave the mark OUTSIDE reach (else the close below is
  // vacuous); how much of the 450 u the chase has already closed is the chase's business.
  assert.ok(gap0 >= CLOSE, `the retreat did not open the gap (${gap0.toFixed(0)} u; -1 = the mark is gone or dead); the chase would prove nothing`);
  // 30 s, not 15: #114 watched the forager close 422 -> 207 u in 15 s -- chasing, just slowly
  // (a kwama forager walks ~15 u/s). A frozen AI closes nothing; that is what this catches.
  const deadline = Date.now() + 30_000;
  const chaseStart = Date.now();
  const q0 = (await probeOf(b, victim)) || p1;
  let gap = gap0;
  while (Date.now() < deadline && gap >= CLOSE) { // -1 (dead/gone) ends the wait too
    await ctx.sleep(500);
    gap = Number(await b.eval(gapExpr));
  }
  // The creature's own ground speed over the window, not just the gap: backlog 479 is a chase
  // that CLOSES but at a crawl (#114 closed at 14 u/s, #115 at 6 u/s, against a kwama forager's
  // run) because the far cell had no navmesh and the AI walked a straight line into terrain.
  // Once the navigator covers every anchor's grid this line is what shows the difference.
  const q1 = await probeOf(b, victim);
  const chaseSecs = (Date.now() - chaseStart) / 1000;
  const covered = q1 && !q1.dead ? Math.hypot(q1.x - q0.x, q1.y - q0.y) : NaN;
  ctx.log(`the ${victim} covered ${covered.toFixed(0)} u in ${chaseSecs.toFixed(1)} s = ${(covered / chaseSecs).toFixed(1)} u/s (closing ${((gap0 - gap) / chaseSecs).toFixed(1)} u/s)`);
  ctx.log(`gap after the chase window: ${gap.toFixed(0)} u (probe=${JSON.stringify(q1)})`);
  assert.ok(gap >= 0 && gap < CLOSE, `the ${victim} never closed from ${gap0.toFixed(0)} to ${CLOSE} u in 30 s (${gap.toFixed(0)}; -1 = it died or left the probe): the peer's AI is frozen two cells from its dummy (pathTo's inactive-cell gate)`);
  ctx.log(`PASS: the peer's ${victim} chased the avatar ${gap0.toFixed(0)} -> ${gap.toFixed(0)} u two cells from the dummy`);
}
