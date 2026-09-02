// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s60 (Phase 4A): THE PEER'S AVATAR BARS ARE THE PLAYER'S BARS.
//
// The player teleports 600 units straight up (tpz: rides the same mpSelfSnap hop the
// reconciliation hard snap uses). The self-teleport announces itself as a PlayerCellChange,
// the peer teleports the AVATAR to match, and the avatar then FALLS on the peer and takes
// fall damage there. The peer reports the damaged bars (AvatarStatsBatch); the server hands
// the owner MP_SelfStats; player.lua mirrors it into the `selfStats` marker.
//
// The marker is the point: a local fall would drop the local hp too, so hp alone proves
// nothing. Only MP_SelfStats sets `selfStats` — its presence with a reduced current value is
// the proof that peer-simulated damage travelled peer → server → owner.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const bootTimeoutMs = 420_000;

export const serverRules = `
[content]
enforce = "off"
`;

const STEP_TIMEOUT = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required)');
    return;
  }
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) {
    ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset). '
      + 'Run under wasm-build/Dockerfile.harness-peer.');
    return;
  }
  const a = await ctx.launchClient('faller', '', BOOT);

  // The peer must hold the cell (its avatar embodies the player there).
  const deadline = Date.now() + 300_000;
  let owner = 'none';
  while (Date.now() < deadline) {
    owner = await a.eval('(window.__omwMP||{}).authorityHolder');
    if (owner && owner !== 'none') break;
    await ctx.sleep(500);
  }
  assert.notEqual(owner, 'none', 'the simulating peer never took the cell');
  ctx.log(`cell owner=${owner}`);

  // Let the input tier and the peer's stats stream settle: full-health reports may or may
  // not arrive (diffed), so do not wait on the marker yet.
  await ctx.sleep(3_000);

  // Up 600 units. The avatar follows the announcement and falls on the peer.
  await a.eval(`Module.__omwMPCmd=${JSON.stringify('tpz:600')}`);
  ctx.log('teleported up 600 units; waiting for the peer-reported bars to drop');

  await a.waitFor(
    `(function(){var s=(window.__omwMP||{}).selfStats; if(!s) return false;`
    + ` var m=/^(\\d+)\\/(\\d+)$/.exec(s); return !!m && Number(m[1]) < Number(m[2]); })()`,
    STEP_TIMEOUT, 'MP_SelfStats with current < base (peer-simulated fall damage)');
  const marker = await a.eval('(window.__omwMP||{}).selfStats');
  ctx.log(`ok: peer-reported bars reached the owner (selfStats=${marker})`);
}
