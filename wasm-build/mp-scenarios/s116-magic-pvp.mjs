// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s116: A SPELL AT ANOTHER PLAYER. s66 proves a sword; this is the magic path, which is a
// different one entirely: the engine applies spell damage itself (mwmechanics/spelleffects.cpp),
// so the attacker's engine parks the effect on the victim's PUPPET (mwmp/puppets.hpp), the
// puppet script drains and forwards it (CombatSpellHit {playerId}), the server routes it to
// the peer because the victim is driving, and the peer applies it to the victim's avatar --
// whose bars come back to the victim as SelfStats. PvP on.
import assert from 'node:assert/strict';

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
  const before = parseBars(await victim.eval('window.omw.state.selfStats'));
  ctx.log(`victim id=${victimId}, bars ${before.c}/${before.b}; casting`);

  const deadline = Date.now() + 60_000;
  let bars = null, dropped = false;
  while (Date.now() < deadline && !dropped) {
    await attacker.cmd(`castp:${victimId}:15`);
    await ctx.sleep(1_500);
    bars = parseBars(await victim.eval('window.omw.state.selfStats'));
    dropped = !!bars && bars.c < before.c;
  }
  ctx.log(`victim bars after: ${bars ? bars.c + '/' + bars.b : 'none'}; attacker castAt=${await attacker.eval('window.omw.state.castAt')} magicFwd=${await attacker.eval('window.omw.state.magicFwd')} spellFwd=${await attacker.eval('window.omw.state.spellFwd')}`);
  assert.ok(dropped, 'the victim\'s peer-reported bars never dropped from a spell: the magic path to another player is broken somewhere between the parked effect and the avatar');
  ctx.log(`ok: a spell at another player landed on their avatar (${before.c} -> ${bars.c})`);
}
