// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s144: A HELPER HEALS A FRIEND. The whole point of jumping into someone's game is to help,
// and the plainest help is a heal. But Restore Health cast at another player's puppet was
// applied LOCALLY on the caster's screen (spelleffects.cpp) and reverted on the wounded
// player's next stats push -- and even the forward path was gated behind PvP, which the co-op
// default turns OFF. So a drop-in helper could not heal anyone. Now beneficial restores are
// diverted like damage, cross the PvP veto (help, not harm), and land on the wounded player's
// avatar on the peer. PvP OFF here on purpose: healing must work in the ordinary friendly game.
import assert from 'node:assert/strict';

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const parseBars = (s) => { const m = /^(\d+)\/(\d+)$/.exec(String(s ?? '')); return m ? { c: Number(m[1]), b: Number(m[2]) } : null; };

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const [hurt, helper] = await Promise.all([ctx.launchClient('hurt', '', BOOT), ctx.launchClient('helper', '', BOOT)]);
  await hurt.waitFor('String(window.omw.state.selfStats||"").indexOf("/") > 0', 300_000, 'the peer reports the hurt player\'s bars (driving)');
  await hurt.waitFor('Number(window.omw.state.playerId||0) > 0', STEP, 'the hurt player knows its id');
  await hurt.waitFor('String(window.omw.state.baselineReady||"") === "1"', STEP, 'the hurt character is settled (identity diffs may speak)');
  const hurtId = Number(await hurt.eval('window.omw.state.playerId'));
  // PvP is OFF (the default): the helper must still be able to heal.
  assert.notEqual(await helper.eval('window.omw.state.pvp'), 'true', 'this proves the friendly default, so PvP must be off');
  await helper.waitFor(`Object.keys(JSON.parse(window.omw.state.puppets||"{}")).includes(String(${hurtId}))`, STEP, 'the helper puppets the hurt player');

  // ROOM TO HEAL, the honest way. hp is gains-only while the peer rules (identity.lua) and
  // client-side damage does not stick on a driving player, so I cannot just lower current.
  // Instead raise the MAX by one legal base step (<=60, base-step accepted) -- current stays
  // where it is, so the player now sits well below full, and a heal (a gain) has somewhere to
  // go and is claimed. s121 proves sethpbase reaches the avatar.
  const start = parseBars(await hurt.eval('window.omw.state.selfStats'));
  const targetMax = start.b + 60;
  await hurt.cmd(`sethpbase:${targetMax}`);
  await hurt.waitFor(`Number(String(window.omw.state.selfStats||"0/0").split("/")[1]) >= ${targetMax - 2}`, STEP, 'the max rose so there is room to heal');
  const before = parseBars(await hurt.eval('window.omw.state.selfStats'));
  assert.ok(before.c < before.b - 20, `the wound never opened a gap (${before.c}/${before.b})`);
  ctx.log(`hurt id=${hurtId}, bars ${before.c}/${before.b}; the helper casts Restore Health`);

  // The helper heals them, repeatedly (a heal spell is small; several top the pool up).
  const deadline = Date.now() + 90_000;
  let bars = before, healed = false;
  while (Date.now() < deadline && !healed) {
    await helper.cmd(`healp:${hurtId}`);
    await ctx.sleep(2_000);
    bars = parseBars(await hurt.eval('window.omw.state.selfStats')) || bars;
    healed = bars.c > before.c + 1; // rose beyond noise
  }
  ctx.log(`hurt bars after: ${bars.c}/${bars.b}; helper castAt=${await helper.eval('window.omw.state.castAt')} spellFwd=${await helper.eval('window.omw.state.spellFwd')}`);
  assert.ok(String(await helper.eval('window.omw.state.castAt')).startsWith('cast:'), 'the helper never cast the heal (no Restore Health spell resolved?)');
  assert.ok(healed, `the hurt player's health never rose from the heal (${before.c} -> ${bars.c}): the beneficial spell did not reach their avatar, or was vetoed by PvP-off`);
  assert.ok(bars.c <= bars.b, 'a heal must not push health past the maximum');
  ctx.log(`PASS: a helper healed a friend with PvP off (${before.c} -> ${bars.c} / ${bars.b})`);
}
