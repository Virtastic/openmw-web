// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s41 (M4): authority handoff. Two clients share a retail cell; the holder's browser is
// hard-killed (SIGKILL — no clean leave, the same abrupt path as s92). The survivor must
// receive ActorAuthorityGrant within a few seconds AND actually take over simulation:
// the cell's NPCs must keep moving (AI resumed), not freeze as orphaned puppets.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const STEP_TIMEOUT = 20_000;
const HANDOFF_BUDGET_MS = 15_000; // spec target ~3s; budget covers the server's leave detection
const MOVE_EPS = 5; // units an actor must travel to count as "not frozen"
const BOOT = { retail: true, joinTimeoutMs: 420_000 };

const probeOf = async (c) => JSON.parse(await c.eval('(window.__omwMP||{}).actorProbe||"{}"'));
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

// Largest distance any shared-record actor moved between two probes.
function maxDelta(p1, p2) {
  let best = 0;
  for (const rec of Object.keys(p1)) {
    if (p2[rec] && !p1[rec].dead) best = Math.max(best, dist(p1[rec], p2[rec]));
  }
  return best;
}

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
    await c.waitFor('Number((window.__omwMP||{}).actorCount||0) > 0', STEP_TIMEOUT, `${c.name} sees cell actors`);
  }
  // Poll until authority settles (Grant lands after the cell-change claim; mirrors are 2 Hz).
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
  assert.equal([holderA, holderB].filter((h) => h === 'true').length, 1, 'exactly one holder before handoff');
  const [holder, peer] = holderA === 'true' ? [a, b] : [b, a];
  ctx.log(`holder is ${holder.name}; killing its browser`);

  // Hard kill — no clean disconnect (s92 pattern).
  const t0 = Date.now();
  holder.close();
  await peer.waitFor('(window.__omwMP||{}).isHolder === "true"', HANDOFF_BUDGET_MS,
    'survivor receives ActorAuthorityGrant');
  const handoffMs = Date.now() - t0;
  ctx.log(`ok: authority handed off in ${handoffMs}ms`);

  // The survivor must now SIMULATE: sample the cell twice and require real motion.
  // (Frozen actors = puppets still waiting on a dead holder's stream.)
  await ctx.sleep(1500); // let AI re-enable and the actors take a step
  let moved = 0;
  const deadline = Date.now() + STEP_TIMEOUT;
  while (Date.now() < deadline && moved < MOVE_EPS) {
    const p1 = await probeOf(peer);
    await ctx.sleep(2500);
    const p2 = await probeOf(peer);
    moved = maxDelta(p1, p2);
  }
  ctx.log(`post-handoff max actor movement: ${moved.toFixed(1)} units`);
  assert.ok(moved >= MOVE_EPS,
    `NPCs frozen after handoff (max movement ${moved.toFixed(1)} < ${MOVE_EPS} units)`);
  ctx.log('ok: NPCs still simulating under the new holder');
}
