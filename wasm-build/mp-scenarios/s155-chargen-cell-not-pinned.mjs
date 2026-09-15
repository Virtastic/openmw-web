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
  assert.ok(moved > 30, `A could not walk in the chargen cell (best ${moved.toFixed(0)} units): the peer streams a frozen avatar there and reconciliation pins the player`);
  assert.ok(maxDiv < 30, `an avatar is being streamed for a player in the chargen sanctuary (divergence ${maxDiv.toFixed(0)})`);
  ctx.log('PASS: a new character walks freely in the chargen sanctuary with a live peer');
}
