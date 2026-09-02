// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s66 (Phase 4A+4B): DAMAGE TO A DRIVING PLAYER LANDS ON THEIR AVATAR, AND THE PEER'S BARS
// ARE WHAT THE OWNER SEES.
//
// The attacker hits the victim (hitp -> CombatHit {playerId}). Because the victim is driving
// the input tier, the server routes the hit to the SIM PEER (4B), which applies it to the
// victim's avatar; the damaged bars travel back as AvatarStatsBatch and the owner receives
// MP_SelfStats (4A), mirrored into `selfStats`. hp alone proves nothing (the old
// victim-applies path would drop it too) -- the selfStats marker only exists on the peer
// path, and that is the assertion.
//
// (The first draft teleported one player 3000 units up to farm fall damage. The engine
// ground-clamps a teleported ACTOR, so the avatar never fell -- and the reconciliation snap
// that pulled the falling client back to its grounded avatar was the authority loop working
// exactly as designed.)
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const bootTimeoutMs = 420_000;

export const serverRules = `
[content]
enforce = "off"
[rules]
pvp = true
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
  const [victim, attacker] = await Promise.all([
    ctx.launchClient('victim', '', BOOT),
    ctx.launchClient('attacker', '', BOOT),
  ]);

  const deadline = Date.now() + 300_000;
  let owner = 'none';
  while (Date.now() < deadline) {
    owner = await victim.eval('(window.__omwMP||{}).authorityHolder');
    if (owner && owner !== 'none') break;
    await ctx.sleep(500);
  }
  assert.notEqual(owner, 'none', 'the simulating peer never took the cell');
  ctx.log(`cell owner=${owner}`);

  // The attacker needs the victim's session id to aim hitp.
  await victim.waitFor("Number((window.__omwMP||{}).playerId||0) > 0", STEP_TIMEOUT, 'victim knows its id');
  const victimId = Number(await victim.eval('(window.__omwMP||{}).playerId'));

  // PRECONDITIONS the earlier draft skipped, and why it never produced a CombatHit:
  //  - pvp must be ON, or the client cancels the hit locally and sends nothing.
  //  - the attacker must be PUPPETING the victim: hitp sends a local Hit to the victim's
  //    puppet on the attacker, and puppet.lua's onHit interceptor is what forwards it. No
  //    puppet, no interceptor, no CombatHit.
  await attacker.waitFor('(window.__omwMP||{}).pvp === "true"', STEP_TIMEOUT, 'attacker sees pvp enabled');
  await attacker.waitFor(
    `Object.keys(JSON.parse((window.__omwMP||{}).puppets||"{}")).includes(String(${victimId}))`,
    STEP_TIMEOUT, 'attacker is puppeting the victim (hitp needs a puppet to intercept)');
  ctx.log(`victim id=${victimId}; attacker puppets it and pvp is on; hitting`);

  // Repeat until the peer-reported bars drop: one hit can race the input-tier warmup.
  const hitUntil = Date.now() + 45_000;
  let dropped = false;
  while (Date.now() < hitUntil && !dropped) {
    await attacker.eval(`Module.__omwMPCmd=${JSON.stringify(`hitp:${victimId}:15`)}`);
    await ctx.sleep(1500);
    const s = String(await victim.eval('(window.__omwMP||{}).selfStats') ?? '');
    const m = /^(\d+)\/(\d+)$/.exec(s);
    if (m && Number(m[1]) < Number(m[2])) dropped = true;
  }
  const marker = await victim.eval('(window.__omwMP||{}).selfStats');
  ctx.log(`selfStats=${marker}`);
  assert.ok(dropped,
    'the peer-reported bars never dropped: either the PvP hit was not routed to the peer '
    + '(4B) or the avatar bar report never reached the owner (4A). selfStats=' + String(marker));
  ctx.log('ok: PvP damage landed on the avatar and the peer-reported bars reached the owner');
}
