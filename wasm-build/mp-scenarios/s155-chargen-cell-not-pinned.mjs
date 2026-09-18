// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s155: A NEW CHARACTER CAN WALK THROUGH THE CENSUS OFFICE. The character-creation cells are a
// sanctuary the server never hands to the peer (no NPC authority there), but nothing kept the
// AVATAR out: the peer spawned one in a cell it does not simulate, frozen, and streamed its
// fixed pose, which the server took as canonical -- so reconciliation pinned a brand-new
// character to the deck at up to 48 units a sample. In those cells the player is
// client-authoritative until they walk out, like any unheld cell.
import assert from 'node:assert/strict';

const STEP = 30_000;
// The Census office, not the ship: the ship's own CharGen script holds the controls until
// the intro has played, so a walk there proves nothing. Both are sanctuary cells.
const BOOT = { retail: true, joinTimeoutMs: 420_000, startCell: 'Seyda Neen, Census and Excise Office' };
const pose = async (c) => JSON.parse(await c.eval('window.omw.state.pose||"null"'));
const dist2 = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const a = await ctx.launchClient('bot-a', '', BOOT);
  await a.waitFor('String(window.omw.state.simReady||"") === "1"', 120_000, 'the world peer is up');
  await a.waitFor('String(window.omw.state.baselineReady||"") === "1"', STEP, 'settled');
  const cell = String(await a.eval('window.omw.state.cell||""'));
  ctx.log(`A is in "${cell}"`);
  assert.match(cell.toLowerCase(), /census/, 'A must start in the Census office');
  await ctx.sleep(4_000); // long enough for a spawned avatar to start streaming, if one were
  // NO ENGINE WINDOW. A new character in the office can have a chargen dialog up (#116:
  // uiMode 'Interface' through all four walks, 18/18/0/25 u), and a window owns the keys --
  // that is not the pin this scenario is about. Wait for it to clear; close it if it lingers.
  for (let i = 0; i < 3; i++) {
    const ok = await a.waitFor("String(window.omw.state.uiMode||'none') === 'none'", 10_000, 'no engine window is up').then(() => true).catch(() => false);
    if (ok) break;
    ctx.log(`  uiMode=${await a.eval('window.omw.state.uiMode')}: sending Escape`);
    await a.eval(`document.getElementById('canvas').focus()`);
    await a.key({ key: 'Escape', code: 'Escape', keyCode: 27, text: '' }); // text: '' -- a name is not a character (s99's ESC)
  }

  // Walk in each direction. The office is cramped (desks, walls): a free player covers a
  // few dozen units before something stops them; a PINNED one covers almost nothing and,
  // the tell, has a live divergence from an avatar that should not exist here.
  let moved = 0, maxDiv = 0;
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const p0 = await pose(a);
    await a.cmd(`walk:${dx},${dy},3000`);
    await ctx.sleep(3_500);
    const d = dist2(p0, await pose(a));
    const div = Number(await a.eval('window.omw.state.selfDivergence||0'));
    ctx.log(`walk ${dx},${dy}: covered ${d.toFixed(0)} units, divergence ${div.toFixed(0)}, stale=${await a.eval('window.omw.state.selfStale||""')}`);
    moved = Math.max(moved, d); maxDiv = Math.max(maxDiv, div);
  }
  // PINNED means a live divergence or a snap, not a short walk: the office is cramped and a
  // 3 s walk into a desk covers 0 (#119: 0/0/21/21 with divergence 0 and no snap, green in
  // #115 at 15/37/31/41). A pin shows as divergence > 32 or a selfSnap; a free player who
  // covered 15 u in some direction is free.
  const snapped = String(await a.eval("window.omw.state.selfSnap||''")) !== '';
  const pinned = maxDiv > 32 || snapped || !(moved >= 15);
  if (pinned) {
    // NOT THE AVATAR (#111: 0 u in all four directions with divergence 0, no avatar spawned on
    // the peer, and one same-cell PlayerCellChange -- a >256 u single-frame jump -- announced
    // during the first walk; #107 walked 31/31/13/26 in the same office). Whatever moved A back
    // is on A's own engine: print what the client can see of it before the verdict.
    const diag = {};
    for (const k of ['uiMode', 'lastKey', 'selfSnap', 'selfStale', 'restorePos', 'restoreFired', 'cell', 'state']) diag[k] = await a.eval(`window.omw.state.${k}||""`);
    ctx.log(`  client mirrors: ${JSON.stringify(diag)}`);
    ctx.log(`  client console tail:\n${a.logTail()}`);
  }
  assert.ok(!pinned, `A is pinned in the chargen cell (best ${moved.toFixed(0)} units, divergence ${maxDiv.toFixed(0)}, snap=${snapped}): the peer streams a frozen avatar there and reconciliation pins the player`);
  assert.ok(maxDiv < 30, `an avatar is being streamed for a player in the chargen sanctuary (divergence ${maxDiv.toFixed(0)})`);
  ctx.log('PASS: a new character walks freely in the chargen sanctuary with a live peer');
}
