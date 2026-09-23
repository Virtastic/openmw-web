// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s174: TAKE THE SILT STRIDER. A service window, clicked.
//
// The coverage map listed "silt strider / boat / guild guide: OK" from a code trace. s122 moves
// players with the snapto: hook and economy.test.ts pays a fare over the wire, but no scenario had
// ever opened the Travel window and picked a destination -- the path every player takes out of
// Seyda Neen. This does: the caravaner's Travel window opens on the client, a real mouse click
// lands on the first destination, and the engine does what the button does (fare, teleport, time).
// Asserted: the player arrives in another cell and STAYS there (the server does not rubber-band a
// paid trip) and the fare left the pack.
//
// RETAIL DATA REQUIRED: the Example Suite has no caravaner.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const CARAVANER = 'darvame hleran'; // Seyda Neen's silt strider
const PURSE = 200;
export const bootTimeoutMs = 420_000;

const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required)');
    return;
  }
  const a = await ctx.launchClient('strider', '', BOOT);

  // A purse for the fare: one frame drains the whole queue, so send them together.
  await a.evalAsync(`Promise.all(Array.from({ length: ${PURSE} }, () => window.omw.send('give:gold_001')))`);
  const goldOf = async () => { await a.cmd('count:gold_001'); return Number(await a.eval('window.omw.state.count')); };
  let gold0 = 0;
  for (let i = 0; i < 20 && gold0 < PURSE; i++) { gold0 = await goldOf(); if (gold0 < PURSE) await ctx.sleep(500); }
  assert.ok(gold0 >= PURSE, `the purse arrived (${gold0} gold)`);
  const cell0 = String(await a.eval('window.omw.state.cell||""'));
  const pose0 = JSON.parse(await a.eval('window.omw.state.pose||"null"'));
  const time0 = String(await a.eval('window.omw.state.gameTime||""'));
  ctx.log(`before: cell=${cell0} gold=${gold0} gameTime=${time0}`);

  // The Travel window, then a real click down the destination list. The window is 500x250 and
  // centred (openmw_travel_window.layout); the list starts 45 GUI units in. Scan the first rows
  // rather than trusting a single pixel: a miss does nothing, a hit travels.
  let travelled = false;
  for (let attempt = 0; attempt < 12 && !travelled; attempt++) {
    if (String(await a.eval('window.omw.state.uiMode||""')) !== 'Travel') {
      await a.cmd(`svc:open:Travel:${CARAVANER}`);
      await a.waitFor(`window.omw.state.uiMode === 'Travel' || window.omw.state.barterGold === 'no-npc'`, 15_000, 'the Travel window opened');
      assert.notEqual(await a.eval('window.omw.state.barterGold'), 'no-npc', `no living ${CARAVANER} nearby`);
      await ctx.sleep(600);
      if (attempt === 0) {
        await a.screenshot(join(ROOT, 'wasm-build', 'harness-out', 's174-travel-window.png'));
        ctx.log(`  window open: ${JSON.stringify(await a.eval(`({ lock: !!document.pointerLockElement,
          wantsLock: !!(window.Module && Module.__omwWantsMouseLock), canvas: (function(){ var c = document.getElementById('canvas');
          var r = c.getBoundingClientRect(); return [c.width, c.height, Math.round(r.width), Math.round(r.height)]; })() })`))}`);
      }
    }
    const at = await a.eval(`(function(){ var c = document.getElementById('canvas'), r = c.getBoundingClientRect();
      var sx = r.width / c.width, sy = r.height / c.height;
      var top = (c.height - 250) / 2, y = top + 40 + ${attempt} * 5;
      return { x: r.left + (c.width / 2) * sx, y: r.top + y * sy }; })()`);
    await a.eval(`document.getElementById('canvas').focus()`);
    await a.clickAt(at.x, at.y);
    await ctx.sleep(2500);
    const cell = String(await a.eval('window.omw.state.cell||""'));
    const pose = JSON.parse(await a.eval('window.omw.state.pose||"null"'));
    if (cell !== cell0 || (pose && dist(pose, pose0) > 4096)) travelled = true;
    else ctx.log(`  click ${attempt} at y=${Math.round(at.y)}: no trip (uiMode=${await a.eval('window.omw.state.uiMode')})`);
  }
  assert.ok(travelled, 'no click on the destination list took the strider');

  // Arrived -- and still there once the server has had its say (a refused far jump snaps back).
  await ctx.sleep(8000);
  const cell1 = String(await a.eval('window.omw.state.cell||""'));
  const pose1 = JSON.parse(await a.eval('window.omw.state.pose||"null"'));
  ctx.log(`after: cell=${cell1} pose=${JSON.stringify(pose1)}`);
  assert.notEqual(cell1, cell0, 'the trip was undone: the player is back in Seyda Neen');
  assert.ok(dist(pose1, pose0) > 4096, `the player is ${Math.round(dist(pose1, pose0))} u from where they boarded`);

  const gold1 = await goldOf();
  const time1 = String(await a.eval('window.omw.state.gameTime||""'));
  // The clock is narrated, not asserted: the world's time is the server's, and whether a trip
  // may move it is the [rules] timeSkip decision, not this window's.
  ctx.log(`fare ${gold0 - gold1} gold; clock ${time0} -> ${time1}`);
  assert.ok(gold1 < gold0, 'the fare left the pack');
  assert.deepEqual(a.luaErrors(), [], 'no Lua error along the way');
  ctx.log('ok: the Travel window was clicked, the fare paid, and the player arrived and stayed');
}
