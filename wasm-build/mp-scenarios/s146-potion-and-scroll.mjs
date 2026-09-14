// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s146: DRINK A POTION, READ A SCROLL. The two most ordinary things a wounded player does,
// and both are LOCAL restorations on a body the peer rules: the client raises its own bar,
// identity.lua claims the gain (hp is gains-only), the peer's avatar takes it and reports
// the bars back. If any link drops, the potion is drunk, the bottle is gone, and the health
// bar snaps back down a moment later -- the worst kind of "it didn't work". Asserted on the
// peer-reported bars (selfStats), and the item is consumed exactly once.
import assert from 'node:assert/strict';

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const POTION = 'p_restore_health_s'; // Cheap Potion of Healing (retail id)
const SCROLL = 'sc_healing'; // Scroll of Healing (retail id, Restore Health on self)

const parseBars = (s) => { const m = /^(\d+)\/(\d+)$/.exec(String(s ?? '')); return m ? { c: Number(m[1]), b: Number(m[2]) } : null; };
const bars = async (c) => parseBars(await c.eval('window.omw.state.selfStats'));
async function countOf(c, id) {
  await c.eval("if (window.omw.state) window.omw.state.count = null; 'cleared';");
  await c.cmd(`count:${id}`);
  await c.waitFor("typeof window.omw.state.count === 'string'", 10_000, `count of ${id} answered`);
  return Number(await c.eval('window.omw.state.count'));
}

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const a = await ctx.launchClient('bot-a', '', BOOT);
  await a.waitFor('String(window.omw.state.selfStats||"").indexOf("/") > 0', 300_000, 'the peer reports the bars (driving)');
  await a.waitFor('String(window.omw.state.baselineReady||"") === "1"', STEP, 'the character is settled (identity diffs may speak)');

  // Room to heal, the same honest way as s144: raise the MAX by a legal base step so current
  // sits below it (client-side damage does not stick on a driving player).
  const start = await bars(a);
  await a.cmd(`sethpbase:${start.b + 60}`);
  await a.waitFor(`Number(String(window.omw.state.selfStats||"0/0").split("/")[1]) >= ${start.b + 58}`, STEP, 'the max rose');
  const wounded = await bars(a);
  assert.ok(wounded.c < wounded.b - 20, `no gap to heal into (${wounded.c}/${wounded.b})`);
  ctx.log(`bars ${wounded.c}/${wounded.b}`);

  // The potion.
  await a.cmd(`give:${POTION}`);
  await a.waitFor(`true`, 1_000, 'granted');
  assert.equal(await countOf(a, POTION), 1, 'the potion must be in the pack');
  await a.cmd(`use:${POTION}`);
  let after = wounded;
  const by1 = Date.now() + 40_000; // a cheap potion restores over ~5 s; the peer reports at ~4 Hz
  while (Date.now() < by1 && !(after.c > wounded.c + 3)) { await ctx.sleep(1_000); after = (await bars(a)) || after; }
  ctx.log(`after the potion: ${after.c}/${after.b}`);
  assert.ok(after.c > wounded.c + 3, `the potion's heal never stuck on the peer-reported bars (${wounded.c} -> ${after.c})`);
  assert.equal(await countOf(a, POTION), 0, 'the bottle must be consumed');

  // The scroll (a self-targeted restore that goes through the cast path, not the potion path).
  const preScroll = after;
  await a.cmd(`give:${SCROLL}`);
  await a.waitFor(`true`, 1_000, 'granted');
  assert.equal(await countOf(a, SCROLL), 1, 'the scroll must be in the pack');
  // A scroll is cast, not read: selected in the magic menu, then the use key in the spell
  // stance -- exactly as a player does it. (UseItem on a scroll only opens its text.)
  await a.cmd(`selectench:${SCROLL}`);
  await ctx.sleep(1_000);
  await a.eval("if (window.omw.state) window.omw.state.selected = null; 'cleared';");
  await a.cmd('selected');
  await a.waitFor("typeof window.omw.state.selected === 'string'", 10_000, 'selection answered');
  const sel = await a.eval('window.omw.state.selected');
  ctx.log(`about to cast: ${sel}`);
  assert.equal(sel, `item:${SCROLL}`, 'the scroll must be the selected enchanted item');
  await a.cmd('stance:spell');
  await ctx.sleep(500);
  await a.cmd('press:400'); // the use key on THIS engine: the cast
  const by2 = Date.now() + 40_000;
  after = preScroll;
  while (Date.now() < by2 && !(after.c > preScroll.c + 3)) { await ctx.sleep(1_000); after = (await bars(a)) || after; }
  ctx.log(`after the scroll: ${after.c}/${after.b} (selfCast=${await a.eval('window.omw.state.selfCast')})`);
  assert.ok(after.c > preScroll.c + 3, `the scroll's heal never stuck (${preScroll.c} -> ${after.c})`);
  assert.equal(await countOf(a, SCROLL), 0, 'the scroll must be consumed');
  assert.ok(after.c <= after.b, 'never past the maximum');
  ctx.log(`PASS: a potion and a scroll both healed a peer-ruled player and were consumed (${wounded.c} -> ${after.c} / ${after.b})`);
}
