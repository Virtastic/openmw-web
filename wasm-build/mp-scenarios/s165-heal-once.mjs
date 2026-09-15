// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s165: A HEAL LANDS ONCE. A self-cast Restore Health over time runs on the caster's own
// engine, and its result travels to the avatar as a raise claim (the bar channel, s112). The
// active-effect mirror carried the SAME effect to the avatar as well, where it ran a second
// time on the ruling body: a 10-for-5 heal restored ~100, a Cheap Potion of Healing ~40
// (backlog 248). s112/s144/s146 never asserted a magnitude, so this passed for a year.
// Here: 100 of 300, a minted restorehealth 10 x 5 s, and the PEER-reported bar must land
// near 150 -- not 200.
import assert from 'node:assert/strict';

// THE SERVER'S OWN PEER, anchored on the players (s147): the avatar must be in processing
// range for its bars to be the ones under test.
export const managedPeer = true;

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };

const parseBars = (s) => { const m = /^(\d+)\/(\d+)$/.exec(String(s ?? '')); return m ? { c: Number(m[1]), b: Number(m[2]) } : null; };
const bars = async (c) => parseBars(await c.eval('window.omw.state.selfStats'));

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const a = await ctx.launchClient('bot-a', '', BOOT);
  await a.waitFor('String(window.omw.state.baselineReady||"") === "1"', 120_000, 'the character is settled (the join-time restore is done)');
  await a.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 120_000, 'the cell is peer-held');
  await a.waitFor('String(window.omw.state.selfStats||"").indexOf("/") > 0', STEP, 'the peer reports the bars');
  await ctx.sleep(3_000);

  // A known pool: 100 of 300 (the s149 idiom -- a base step the server accepts, then a raise
  // claim inside the restore budget).
  await a.cmd('sethpbase:300');
  await a.waitFor('Number(String(window.omw.state.selfStats||"0/0").split("/")[1]) >= 298', STEP, 'the max rose to 300');
  await a.cmd('sethp:100');
  await a.waitFor('Number(String(window.omw.state.selfStats||"0/0").split("/")[0]) >= 95', STEP, 'the pool sits at 100');
  await ctx.sleep(3_000);
  const before = await bars(a);
  ctx.log(`before the heal: ${before.c}/${before.b}`);
  assert.ok(before.c >= 95 && before.c <= 110, `the pool did not settle at 100 (${before.c}/${before.b})`);

  // The cast: a minted restorehealth 10 x 5 s, learned and selected by the engine, cast
  // through the spell stance and the use key on THIS engine (the s147 castSelf idiom). A
  // fresh character fizzles most self-spells; skill up inside the server's legal step.
  await a.eval("if (window.omw.state) window.omw.state.mintedSpell = null; 'cleared';");
  await a.cmd('mintspell:restorehealth:10:5');
  await a.waitFor("typeof window.omw.state.mintedSpell === 'string'", 10_000, 'the spell was minted and selected');
  const id = await a.eval('window.omw.state.mintedSpell');
  await a.waitFor(`Object.values(JSON.parse(window.omw.state.netRecords||"{}")).includes(${JSON.stringify(id)})`, 20_000, 'the minted spell is registered with the server');
  await a.cmd('setskill:restoration:65');
  await a.cmd('setmp:300');
  await a.cmd('stance:spell');
  await ctx.sleep(700);
  await a.cmd('press:500');
  // The heal runs 5 s on the client; give the raise claim and the peer's reports time to settle.
  await ctx.sleep(8_000);
  const after = await bars(a);
  const local = Number(await a.eval('window.omw.state.hp'));
  ctx.log(`after the heal: peer says ${after.c}/${after.b}, the client's own bar says ${local}`);
  assert.ok(after.c > before.c + 30, `the heal never landed (${before.c} -> ${after.c}); did the cast fizzle?`);
  // ONCE: 100 + 50. Twice is 200.
  assert.ok(after.c >= 145 && after.c <= 160,
    `a 50-point heal moved the ruled body ${before.c} -> ${after.c}: ${after.c > 160 ? 'it landed twice (the bar channel AND the effect mirror)' : 'off by more than the budget'}`);
  ctx.log(`PASS: the heal landed once (${before.c} -> ${after.c})`);
}
