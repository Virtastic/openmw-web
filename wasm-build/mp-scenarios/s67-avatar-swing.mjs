// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s67 (Phase 4C): THE PLAYER'S ATTACK REACHES THEIR AVATAR ON THE PEER.
//
// Melee is computed on the peer now: the owner's use bit rides the input tier (0x0102),
// the peer routes it to the avatar (avatar.lua maps it onto controls.use), the engine swings,
// and the hit is resolved natively against the actors the peer holds -- no client assertion
// in the loop. The client's real swing is cancel-only while the peer simulates (combat.lua
// onPuppetHit); only the degraded relay and the test hooks still forward.
//
// What this proves is the WIRING, end to end: attack:<ms> holds the use bit -> input frames
// carry bit 3 -> the peer's avatar consumes them (global.lua stamps `avatarUsing`) -> the
// authoritative pose stream sets flags bit 3 -> the owner's state batch (0x0103) carries it
// -> player.lua mirrors it as `selfFlags`. The swing itself is stock OpenMW: an actor whose
// controls.use is 1 attacks -- the same code path a single-player character uses.
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
  const a = await ctx.launchClient('swinger', '', BOOT);

  const deadline = Date.now() + 300_000;
  let owner = 'none';
  while (Date.now() < deadline) {
    owner = await a.eval('window.omw.state.authorityHolder');
    if (owner && owner !== 'none') break;
    await ctx.sleep(500);
  }
  assert.notEqual(owner, 'none', 'the simulating peer never took the cell');
  ctx.log(`cell owner=${owner}`);

  // The state stream must be flowing before the attack, or a missing flag is ambiguous.
  await a.waitFor('window.omw.state.selfFlags !== undefined', STEP_TIMEOUT,
    'the authoritative self state stream reaches the owner (selfFlags mirror)');
  const idle = Number(await a.eval('window.omw.state.selfFlags'));
  assert.equal(idle & 8, 0, `the avatar must not be attacking before the input says so (flags=${idle})`);

  // Hold the attack for 4 s: at 30 Hz input and a 20 Hz peer, the flag has to appear.
  await a.eval("window.omw.send('attack:4000')");
  ctx.log('holding attack; waiting for the avatar’s attacking flag to come back');
  await a.waitFor('(Number(window.omw.state.selfFlags||0) & 8) === 8', STEP_TIMEOUT,
    'the peer avatar reports attacking (input use bit -> avatar -> state stream)');
  ctx.log('ok: the attack reached the avatar and came back on the authoritative stream');

  // And it RELEASES: a held bit that never clears would be a permanently swinging avatar.
  await a.waitFor('(Number(window.omw.state.selfFlags||0) & 8) === 0', STEP_TIMEOUT,
    'the attacking flag clears once the input stops holding it');
  ctx.log('ok: the attack released');
}
