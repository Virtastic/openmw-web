// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s116: A SPELL AT ANOTHER PLAYER. s66 proves a sword; this is the magic path, which is a
// different one entirely: the engine applies spell damage itself (mwmechanics/spelleffects.cpp),
// so the attacker's engine parks the effect on the victim's PUPPET (mwmp/puppets.hpp), the
// puppet script drains and forwards it (CombatSpellHit {playerId}), the server routes it to
// the peer because the victim is driving, and the peer applies it to the victim's avatar --
// whose bars come back to the victim as SelfStats. PvP on.
import assert from 'node:assert/strict';
import { prepareCast, castAt, FIRE_BITE } from './_spell.mjs';

export const serverRules = `
[content]
enforce = "off"
[rules]
pvp = true
`;
const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const parseBars = (s) => { const m = /^(\d+)\/(\d+)$/.exec(String(s ?? '')); return m ? { c: Number(m[1]), b: Number(m[2]) } : null; };

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const [victim, attacker] = await Promise.all([ctx.launchClient('victim', '', BOOT), ctx.launchClient('attacker', '', BOOT)]);
  await victim.waitFor('String(window.omw.state.selfStats||"").indexOf("/") > 0', 300_000, 'the peer reports the victim\'s bars (driving)');
  await victim.waitFor('Number(window.omw.state.playerId||0) > 0', STEP, 'victim knows its id');
  const victimId = Number(await victim.eval('window.omw.state.playerId'));
  await attacker.waitFor('window.omw.state.pvp === "true"', STEP, 'attacker sees pvp enabled');
  await attacker.waitFor(`Object.keys(JSON.parse(window.omw.state.puppets||"{}")).includes(String(${victimId}))`, STEP, 'attacker puppets the victim');
  // A REAL CAST (backlog 242): Fire Bite on touch, from beside the victim's puppet. The
  // castp: hook parked the effect straight onto the puppet and stayed green with the
  // engine's own cast path dead.
  const puppetOf = `(JSON.parse(window.omw.state.puppets||"{}")[${JSON.stringify(String(victimId))}]||{})`;
  const at = JSON.parse(await attacker.eval(`JSON.stringify(${puppetOf})`));
  await attacker.cmd(`snapto:${Math.round(at.x + 60)},${Math.round(at.y)},${Math.round(at.z + 8)}`);
  await ctx.sleep(3_000);
  await prepareCast(attacker, ctx, FIRE_BITE, 'destruction');
  const before = parseBars(await victim.eval('window.omw.state.selfStats'));
  ctx.log(`victim id=${victimId}, bars ${before.c}/${before.b}; the attacker casts ${FIRE_BITE} at the puppet`);

  const deadline = Date.now() + 90_000;
  let bars = null, dropped = false, casts = 0;
  while (Date.now() < deadline && !dropped) {
    const p = JSON.parse(await attacker.eval(`JSON.stringify(${puppetOf})`));
    await castAt(attacker, ctx, p); casts++;
    bars = parseBars(await victim.eval('window.omw.state.selfStats'));
    dropped = !!bars && bars.c <= before.c - 1;
  }
  ctx.log(`victim bars after ${casts} cast(s): ${bars ? bars.c + '/' + bars.b : 'none'}; attacker magicFwd=${await attacker.eval('window.omw.state.magicFwd')} spellFwd=${await attacker.eval('window.omw.state.spellFwd')} stance=${await attacker.eval('window.omw.state.stance')}`);
  assert.ok(dropped, 'the victim\'s peer-reported bars never dropped from a real cast: the cast fizzled, missed the puppet, or the magic path to another player is broken between the puppet seam and the avatar');
  ctx.log(`ok: a spell at another player landed on their avatar (${before.c} -> ${bars.c})`);
}
