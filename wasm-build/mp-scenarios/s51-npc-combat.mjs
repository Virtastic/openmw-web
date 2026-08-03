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
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required for shared NPCs)');
    return;
  }
  const [a, b] = await Promise.all([
    ctx.launchClient('bot-a', '', BOOT),
    ctx.launchClient('bot-b', '', BOOT),
  ]);
  for (const c of [a, b]) {
    await c.waitFor('Number((window.__omwMP||{}).actorCount||0) > 0', STEP_TIMEOUT, `${c.name} sees actors`);
  }

  // Settle authority (Grant lands after the cell-change claim; mirrors are 2 Hz).
  let holderA = null;
  let holderB = null;
  const authDeadline = Date.now() + STEP_TIMEOUT;
  while (Date.now() < authDeadline) {
    [holderA, holderB] = await Promise.all([
      a.eval('(window.__omwMP||{}).isHolder'),
      b.eval('(window.__omwMP||{}).isHolder'),
    ]);
    if ([holderA, holderB].filter((h) => h === 'true').length === 1) break;
    await ctx.sleep(500);
  }
  assert.equal([holderA, holderB].filter((h) => h === 'true').length, 1, 'exactly one holder');
  const [holder, peer] = holderA === 'true' ? [a, b] : [b, a];
  ctx.log(`holder=${holder.name}, non-holder=${peer.name}`);

  // A victim both clients can see.
  const [ph, pp] = await Promise.all([probeOf(holder), probeOf(peer)]);
  // Prefer a settled NPC over a wandering creature. Creatures like the mudcrab roam far
  // enough to leave the peer's visible set mid-test, which times out the relay assert on a
  // scenario that is really about combat routing — a flake, not a product defect. Records
  // with a space in the id are Morrowind's named NPCs ("indrele rathryon"); single-word
  // ids are typically creatures ("mudcrab"). Fall back to anything living if none exist.
  const living = Object.keys(ph).filter((r) => pp[r] && !ph[r].dead);
  const victim = living.find((r) => r.includes(' ')) ?? living[0];
  assert.ok(victim, 'need a living NPC visible to both clients');
  ctx.log(`victim NPC: ${victim}`);

  // The non-holder attacks first. Its hit lands on a PUPPET, so it must be intercepted,
  // forwarded, and applied by the holder — the holder's combat applier records the raw
  // damage it received. This is the assertion that proves cross-client NPC combat works
  // (and the one that fails loudly if the non-holder cannot address the cell's epoch).
  await peer.eval(`Module.__omwMPCmd=${JSON.stringify('hitn:' + victim + ':40')}`);
  await holder.waitFor('(window.__omwMP||{}).lastHitTaken === "40"', STEP_TIMEOUT,
    "the non-holder's hit reached the authority holder");
  ctx.log("ok: non-holder's hit forwarded to and applied by the holder");

  // The holder also attacks it directly (applied locally, no round trip).
  await holder.eval(`Module.__omwMPCmd=${JSON.stringify('hitn:' + victim + ':40')}`);

  // Finish it off from the holder so death is deterministic regardless of NPC hp.
  await ctx.sleep(1200);
  await holder.eval(`Module.__omwMPCmd=${JSON.stringify('killnpc:' + victim)}`);

  const deadExpr = `((JSON.parse((window.__omwMP||{}).actorProbe||"{}")[${JSON.stringify(victim)}]||{}).dead === true)`;
  await holder.waitFor(deadExpr, STEP_TIMEOUT, 'NPC dead on the holder');
  await peer.waitFor(deadExpr, STEP_TIMEOUT, 'NPC dead on the non-holder');

  // Exactly ONE kill counted, on both clients (server dedups by (ref, deathNo)).
  const tally = `(window.__omwMP||{}).killCountOf === ${JSON.stringify(victim + '=1')}`;
  await holder.waitFor(tally, STEP_TIMEOUT, 'kill tally = 1 on the holder');
  await peer.waitFor(tally, STEP_TIMEOUT, 'kill tally = 1 on the non-holder');
  ctx.log('ok: NPC died once on both clients, shared kill count = 1');
}
