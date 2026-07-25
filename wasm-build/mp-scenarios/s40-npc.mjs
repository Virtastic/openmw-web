// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s40 (M4): shared NPCs under cell authority.
//   1. Two clients in the same retail cell; exactly ONE is the authority holder.
//   2. Both see the same content NPCs at (near) the same positions — the non-holder's
//      view is puppet-driven off ActorMoveBatch, so it converges within a bounded error.
//   3. Killing an NPC on the holder kills it on the non-holder (ActorDeath relay) and
//      bumps the SHARED kill tally on both (WorldKillCount -> mp.setDeadCount).
//
// RETAIL DATA REQUIRED: the clean Example Suite ships no NPCs at all (its only active
// actors are the player and MP puppets), so shared-NPC authority cannot be exercised on
// the demo content. Skips cleanly when play/mwdata is absent.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CONVERGE_EPS = 80; // units; puppet steering + 100ms render delay + 2Hz mirrors
const STEP_TIMEOUT = 20_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };

const probeOf = async (c) => JSON.parse(await c.eval('(window.__omwMP||{}).actorProbe||"{}"'));
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required for shared NPCs)');
    return;
  }
  const [a, b] = await Promise.all([
    ctx.launchClient('bot-a', '', BOOT),
    ctx.launchClient('bot-b', '', BOOT),
  ]);

  // Authority: exactly one holder for the shared cell. The Grant lands a moment AFTER the
  // actors become active (server processes PlayerCellChange, then claims), and the mirrors
  // are 2 Hz — poll both until the authority state settles rather than reading once.
  await a.waitFor('Number((window.__omwMP||{}).actorCount||0) > 0', STEP_TIMEOUT, 'A sees cell actors');
  await b.waitFor('Number((window.__omwMP||{}).actorCount||0) > 0', STEP_TIMEOUT, 'B sees cell actors');
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
  ctx.log(`isHolder A=${holderA} B=${holderB}`);
  assert.equal([holderA, holderB].filter((h) => h === 'true').length, 1,
    'exactly one client must hold cell authority');
  const [holder, peer] = holderA === 'true' ? [a, b] : [b, a];

  // Same NPCs, converged positions. Compare records present on BOTH clients.
  let shared = [];
  const deadline = Date.now() + STEP_TIMEOUT;
  let worst = Infinity;
  let worstRec = null;
  while (Date.now() < deadline) {
    const [ph, pp] = await Promise.all([probeOf(holder), probeOf(peer)]);
    shared = Object.keys(ph).filter((r) => pp[r]);
    if (shared.length >= 3) {
      worst = 0;
      for (const rec of shared) {
        const d = dist(ph[rec], pp[rec]);
        if (d > worst) { worst = d; worstRec = rec; }
      }
      if (worst < CONVERGE_EPS) break;
    }
    await ctx.sleep(500);
  }
  ctx.log(`${shared.length} shared NPCs; worst convergence error ${worst.toFixed(1)} units (${worstRec})`);
  assert.ok(shared.length >= 3, `expected >=3 shared NPCs, got ${shared.length}`);
  assert.ok(worst < CONVERGE_EPS, `puppet NPCs did not converge: ${worst.toFixed(1)} units`);

  // Kill an NPC on the holder -> dead on both + shared tally bumps.
  const victim = shared.find((r) => r && r.length > 0);
  ctx.log(`killing "${victim}" on the holder (${holder.name})`);
  await holder.eval(`Module.__omwMPCmd=${JSON.stringify('killnpc:' + victim)}`);
  const deadExpr = `((JSON.parse((window.__omwMP||{}).actorProbe||"{}")[${JSON.stringify(victim)}]||{}).dead === true)`;
  await holder.waitFor(deadExpr, STEP_TIMEOUT, 'NPC dead on the holder');
  await peer.waitFor(deadExpr, STEP_TIMEOUT, 'NPC dead on the non-holder (ActorDeath relay)');
  ctx.log('ok: death relayed to the non-holder');

  // Shared kill tally (WorldKillCount -> mp.setDeadCount) reaches BOTH clients.
  const tallyExpr = `((window.__omwMP||{}).killCountOf||"") === ${JSON.stringify(victim + '=1')}`;
  await holder.waitFor(tallyExpr, STEP_TIMEOUT, 'kill tally on the holder');
  await peer.waitFor(tallyExpr, STEP_TIMEOUT, 'kill tally on the non-holder');
  ctx.log(`ok: shared kill count = 1 for "${victim}" on both clients`);
}
