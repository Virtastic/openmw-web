// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s122: A TELEPORT STICKS. Fast travel, Recall, a Divine Intervention, a door: the player
// lands somewhere far and must STAY there. Two competing authorities can pull them back --
// the peer's avatar stream (until the avatar arrives) and the rejoin position hold -- and a
// late loser drags the player to where they were, then the other side drags them back
// again. Seen twice in batches (s110/s117: -2,-7 -> -2,-9 -> -2,-7 -> -2,-9) and never
// alone. This snaps far, watches the cell for a while, and prints every move if it wobbles.
import assert from 'node:assert/strict';

const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const FAR = '-12500,-53100,512'; // -2,-7, two cells from the Seyda Neen spawn (-2,-9)

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-7');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const a = await ctx.launchClient('bot-a', '', BOOT);
  await a.waitFor('window.omw.state.state === "Joined"', 60_000, 'A joined');
  await a.waitFor('String(window.omw.state.baselineReady||"") === "1"', 60_000, 'the character is settled (chargen done or restore landed)');
  ctx.log(`restoreFired=${await a.eval('window.omw.state.restoreFired')} restorePos=${await a.eval('window.omw.state.restorePos')}`);
  const home = String(await a.eval('window.omw.state.cell||""'));
  await a.cmd('snapto:' + FAR);
  await a.waitFor('String(window.omw.state.cell||"") === "-2,-7"', 30_000, 'A landed two cells north');

  // Stay put for 20 s. Every cell the mirror shows is recorded; anything but -2,-7 is a drag.
  const seen = new Set();
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    seen.add(String(await a.eval('window.omw.state.cell||""')));
    await ctx.sleep(250);
  }
  const wobble = [...seen].filter((c) => c !== '-2,-7');
  if (wobble.length) {
    const lines = (a.logTail ? a.logTail(4000) : '').split(String.fromCharCode(10)).filter((l) => /\[mp\]/.test(l) && /SNAP|snap|restore|teleport|cell|hold/.test(l)).slice(-40);
    ctx.log('A movement-related [mp] lines: ' + lines.join(' || '));
  }
  assert.equal(wobble.length, 0, `A was dragged out of -2,-7 after the teleport (cells seen: ${[...seen].join(', ')}; home was ${home})`);
  ctx.log('ok: the teleport stuck for 20 s');
}
