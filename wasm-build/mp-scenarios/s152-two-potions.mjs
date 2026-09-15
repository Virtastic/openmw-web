// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s152: TWO POTIONS OF THE SAME KIND ARE TWO POTIONS. In a fight you chug two healing
// potions in a row; the second must keep working after the first runs out. The effect mirror
// keys the owner's instances but the peer removed BY RECORD: the first expiry stripped every
// instance from the avatar, the peer then reported "gone" to the owner, and the owner's copy
// of the second potion was cancelled too. Asserted on the owner's own active-spell list:
// two instances, then one, then none -- never two straight to none.
import assert from 'node:assert/strict';

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
// A FORTIFY potion, not a restore: restore health lasts 5 s, and on a loaded box one poll of
// the active list takes 4 s, so the window in which exactly one instance is left was never
// sampled (2 -> 0 looked like the bug it was written to catch). Fortify Health lasts long
// enough that a 20 s gap leaves a 20 s window with one instance.
const POTION = 'p_fortify_health_e'; // Exclusive: the longest of the line
const GAP_MS = 20_000;

const parseBars = (s) => { const m = /^(\d+)\/(\d+)$/.exec(String(s ?? '')); return m ? { c: Number(m[1]), b: Number(m[2]) } : null; };
const bars = async (c) => parseBars(await c.eval('window.omw.state.selfStats'));
async function actives(c) {
  await c.eval("if (window.omw.state) window.omw.state.actives = null; 'cleared';");
  await c.cmd('actives');
  await c.waitFor("typeof window.omw.state.actives === 'string'", 10_000, 'actives answered');
  return String(await c.eval('window.omw.state.actives')).split(',').filter(Boolean);
}

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const a = await ctx.launchClient('bot-a', '', BOOT);
  await a.waitFor('String(window.omw.state.selfStats||"").indexOf("/") > 0', 300_000, 'the peer reports the bars (driving)');
  await a.waitFor('String(window.omw.state.baselineReady||"") === "1"', STEP, 'settled');

  // Room to heal (s144's way), so the potions have work to do.
  const start = await bars(a);
  await a.cmd(`sethpbase:${start.b + 60}`);
  await a.waitFor(`Number(String(window.omw.state.selfStats||"0/0").split("/")[1]) >= ${start.b + 58}`, STEP, 'the max rose');
  await a.cmd(`give:${POTION}`);
  await a.cmd(`give:${POTION}`);
  await ctx.sleep(500);

  // Drink, wait, drink; then watch the instance count every 250 ms until both are gone.
  await a.cmd(`use:${POTION}`);
  await ctx.sleep(GAP_MS);
  await a.cmd(`use:${POTION}`);
  const seen = []; // instance counts over time, with seconds since the second drink
  const t0 = Date.now();
  const by = t0 + 120_000;
  let maxSeen = 0, sawOneAfterTwo = false;
  while (Date.now() < by) {
    const n = (await actives(a)).filter((id) => id === POTION).length;
    seen.push(`${((Date.now() - t0) / 1000).toFixed(1)}s:${n}`);
    maxSeen = Math.max(maxSeen, n);
    if (maxSeen === 2 && n === 1) sawOneAfterTwo = true;
    if (maxSeen >= 1 && n === 0) break;
  }
  ctx.log(`instances over time: ${seen.join(' ')}`);
  assert.equal(maxSeen, 2, `both potions must be active together (peak ${maxSeen})`);
  assert.ok(sawOneAfterTwo, 'the second potion was cancelled with the first (2 -> 0, never 1): the peer removed every instance of the record');
  const end = await bars(a);
  ctx.log(`PASS: two potions ran as two (${start.c} -> ${end.c} / ${end.b}); the second outlived the first`);
}
