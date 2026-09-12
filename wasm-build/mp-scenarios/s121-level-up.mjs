// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s121: A LEVEL-UP RAISES THE MAXIMUM ON THE BODY THAT FIGHTS. Levelling happens on the
// player's own client (skills, attributes, level all travel as client diffs), and the peer's
// avatar rules the bars. The new maximum has to reach the avatar, or the player who levelled
// mid-session keeps the old health pool on the body that takes the hits until they relog --
// and their own bar keeps snapping back to the old cap.
import assert from 'node:assert/strict';

const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const parseBars = (s) => { const m = /^(\d+)\/(\d+)$/.exec(String(s ?? '')); return m ? { c: Number(m[1]), b: Number(m[2]) } : null; };

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const a = await ctx.launchClient('bot-a', '', BOOT);
  await a.waitFor('String(window.omw.state.selfStats||"").indexOf("/") > 0', 300_000, 'the peer reports the bars of A (driving)');
  const before = parseBars(await a.eval('window.omw.state.selfStats'));
  ctx.log(`peer-reported health ${before.c}/${before.b}`);

  // The level-up: the maximum rises by 15 on the client.
  const want = before.b + 15;
  await a.cmd(`sethpbase:${want}`);
  const deadline = Date.now() + 20_000;
  let bars = null;
  while (Date.now() < deadline) {
    bars = parseBars(await a.eval('window.omw.state.selfStats'));
    if (bars && bars.b === want) break;
    await ctx.sleep(400);
  }
  ctx.log(`after the level-up: peer-reported ${bars ? bars.c + '/' + bars.b : 'none'}`);
  assert.ok(bars && bars.b === want, `the new maximum never reached the avatar (peer still reports base ${bars?.b}): a level-up mid-session is lost on the body that fights`);
  assert.ok(bars.c >= Math.min(before.c, want), 'current health was not preserved across the new maximum');

  // And a heal now reaches the new cap, not the old one.
  await a.cmd(`sethp:${want}`);
  const healBy = Date.now() + 20_000;
  while (Date.now() < healBy) {
    bars = parseBars(await a.eval('window.omw.state.selfStats'));
    if (bars && bars.c >= want) break;
    await ctx.sleep(400);
  }
  assert.ok(bars && bars.c >= want, `a heal to the new maximum stopped short: ${bars?.c}/${bars?.b}`);
  ctx.log(`ok: the level-up reached the avatar and a heal fills the new pool (${bars.c}/${bars.b})`);
}
