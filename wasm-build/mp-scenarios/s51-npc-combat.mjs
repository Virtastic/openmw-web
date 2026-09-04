// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s51 (M5): shared NPC combat. Both players attack the SAME NPC — one of them holds the
// cell's authority (applies damage locally), the other is a non-holder whose hit must be
// forwarded to the holder. The NPC dies exactly ONCE on both clients and the shared kill
// tally increments exactly once (M4 ActorDeath dedup by (ref, deathNo)).
//
// RETAIL DATA REQUIRED (the clean Example Suite places no NPCs) — skips without it.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const STEP_TIMEOUT = 25_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };

const probeOf = async (c) => JSON.parse(await c.eval('(window.__omwMP||{}).actorProbe||"{}"'));

export default async function run(ctx) {
  // A SIMULATING peer holds the cell. Both browsers are therefore NON-holders, which is the
  // real shape of shared NPC combat: nobody fighting an NPC owns it.
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required for shared NPCs)');
    return;
  }
  // Start the peer FIRST: it boots a whole retail game before it can take a cell (~2.5 min on a
  // GPU-less box), so it needs to overlap the browsers rather than follow them.
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) {
    ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset). '
      + 'Run under wasm-build/Dockerfile.harness-peer.');
    return;
  }
  const [a, b] = await Promise.all([
    ctx.launchClient('bot-a', '', BOOT),
    ctx.launchClient('bot-b', '', BOOT),
  ]);
  const clients = [a, b];
  for (const c of [a, b]) {
    await c.waitFor('Number((window.__omwMP||{}).actorCount||0) > 0', STEP_TIMEOUT, `${c.name} sees actors`);
  }

  // AUTHORITY IS THE PEER'S. This scenario used to elect one of the two CLIENTS as holder and
  // assert the other's hit was forwarded to it. `canSimulate` is `p.system === true` now, so
  // neither client holds anything and BOTH hits have to travel — which is a better test of the
  // same thing, and the shape real play has.
  let ownerSeen = 'none';
  const authDeadline = Date.now() + Number(process.env.S51_PEER_TIMEOUT ?? 300_000);
  while (Date.now() < authDeadline) {
    ownerSeen = await a.eval('(window.__omwMP||{}).authorityHolder');
    if (ownerSeen && ownerSeen !== 'none') break;
    await ctx.sleep(500);
  }
  assert.notEqual(ownerSeen, 'none', 'the simulating peer never took the cell');
  assert.equal(await a.eval('(window.__omwMP||{}).isHolder'), 'false', 'client A must not hold');
  assert.equal(await b.eval('(window.__omwMP||{}).isHolder'), 'false', 'client B must not hold');
  ctx.log(`cell owner=${ownerSeen}; neither client holds it`);

  for (const c of clients) {
    await c.waitFor('Number((window.__omwMP||{}).puppetedActors||0) > 0', STEP_TIMEOUT,
      `${c.name} puppeted the cell actors`);
  }

  const [ph, pp] = await Promise.all([probeOf(a), probeOf(b)]);
  const victim = Object.keys(ph).find((r) => r !== 'player' && pp[r]
    && ph[r].dead !== true && pp[r].dead !== true);
  assert.ok(victim, 'need a living NPC visible to both clients');
  ctx.log(`both clients attacking "${victim}"`);

  // BOTH clients are non-holders, so every one of these hits must be intercepted locally,
  // forwarded, routed by the server to the peer, and applied there. Nothing a browser does
  // to this NPC counts unless that whole chain works — which is precisely the path that was
  // reported broken as "hits are not registering".
  const deadExpr = `((JSON.parse((window.__omwMP||{}).actorProbe||"{}")[${JSON.stringify(victim)}]||{}).dead === true)`;
  const swingDeadline = Date.now() + 90_000;
  let died = false;
  while (Date.now() < swingDeadline && !died) {
    // c.cmd, not a raw slot write: the slot holds ONE command and drains about once per frame,
    // so swinging on a 600 ms timer overwrote most of these before the engine saw them. The NPC
    // then never died and this scenario reported the "my attacks do nothing" bug it exists to
    // catch -- from the harness, not the product. It passed solo and failed in-suite for exactly
    // that reason.
    await a.cmd('hitn:' + victim + ':40');
    await ctx.sleep(600);
    await b.cmd('hitn:' + victim + ':40');
    await ctx.sleep(600);
    died = (await a.eval(deadExpr)) === true || (await b.eval(deadExpr)) === true;
  }
  assert.ok(died,
    'the NPC never died: hits from non-holders are not reaching the cell owner, which is the '
    + '"my attacks do nothing" failure');
  ctx.log('ok: the NPC died from hits routed through the cell owner');

  // The death is authored by the peer and must reach BOTH players, not just whoever swung last.
  await a.waitFor(deadExpr, STEP_TIMEOUT, 'NPC dead on client A');
  await b.waitFor(deadExpr, STEP_TIMEOUT, 'NPC dead on client B');

  // Exactly ONE kill counted on both clients (server dedups by (ref, deathNo)) — two players
  // hitting the same NPC must not score it twice.
  const tally = `(window.__omwMP||{}).killCountOf === ${JSON.stringify(victim + '=1')}`;
  await a.waitFor(tally, STEP_TIMEOUT, 'kill tally = 1 on client A');
  await b.waitFor(tally, STEP_TIMEOUT, 'kill tally = 1 on client B');
  ctx.log('ok: NPC died once for both players, shared kill count = 1');
}
