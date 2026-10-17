// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s189: A DOOR THAT DOES NOT TAKE YOU ANYWHERE SHOWS NO LOADING SCREEN; ONE THAT DOES, DOES.
// Player report 2026-10-15: "when we open doors and they are locked or do not actually load us
// to another area it sometimes shows the loading screen and goes back". The overlay goes up on
// door ACTIVATION (global.lua signalCellLoad) because a load freezes the page and the screen
// must already be there; a scripted door that refuses you, a message box, a dialogue, then
// pulled it down 0.6 s later. Now it goes up transparent and is withdrawn after a quarter
// second of normal frames in the same place (index.html watchCellLoad).
//
// Refused: the cellLoad mirror bumped by hand with no travel -- exactly what such a door does.
// Sampled every frame for a second: never visibly on (opacity > 0.05), gone afterwards.
// Real: door:enter through the nearest load door; the screen is up when the page comes back.
//
// RETAIL DATA REQUIRED.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const managedPeer = true;
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const bootTimeoutMs = 420_000;

const WATCH = `(function(){ window.__s189 = null;
  var el = document.getElementById('loading'), max = 0, t0 = performance.now();
  window.omw.state.cellLoad = 'refused-' + Date.now();
  (function f(){
    var vis = el.style.display !== 'none' ? parseFloat(getComputedStyle(el).opacity) : 0;
    if (vis > max) max = vis;
    if (performance.now() - t0 < 1000) requestAnimationFrame(f);
    else window.__s189 = JSON.stringify({ max: max, display: el.style.display, cls: el.className });
  })();
  return 'started';
})()`;
const SHOWN = `(function(){var el=document.getElementById('loading');
  return el.style.display !== 'none' && !el.classList.contains('hide') ? parseFloat(getComputedStyle(el).opacity) : 0;})()`;

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required)');
    return;
  }
  const a = await ctx.launchClient('doorman', '', { retail: true, joinTimeoutMs: 420_000 });
  await a.waitFor("(function(){var el=document.getElementById('loading');return el.style.display==='none'||el.classList.contains('hide');})()", 60_000, 'the boot screen cleared');
  await ctx.sleep(2_000);

  await a.eval(WATCH);
  await a.waitFor('window.__s189 !== null', 5_000, 'the frame watch finished');
  const refused = JSON.parse(await a.eval('window.__s189'));
  ctx.log(`refused door: peak opacity ${refused.max.toFixed(2)}, display=${refused.display || 'shown'} class="${refused.cls}"`);
  assert.ok(refused.max <= 0.05, `a door that took us nowhere flashed the loading screen (opacity ${refused.max})`);
  assert.equal(refused.display, 'none', 'and it is gone afterwards');

  const cell0 = String(await a.eval('String(window.omw.state.cell||"")'));
  // The longest frame of the trip: a load freezes the page, and THAT is what the screen covers.
  await a.eval('window.__gap = 0; window.__gapOn = true; (function f(t0){ requestAnimationFrame(function(t){ if (t0) window.__gap = Math.max(window.__gap, t - t0); if (window.__gapOn) f(t); }); })(0); 1');
  await a.cmd('door:enter');
  let peak = 0, cell = cell0;
  for (let i = 0; i < 60 && cell === cell0; i++) {
    let o = 0; try { o = Number(await a.eval(SHOWN)); } catch { /* the page is frozen in the load */ }
    if (o > peak) peak = o;
    cell = String(await a.eval('String(window.omw.state.cell||"")'));
    await ctx.sleep(100);
  }
  for (let i = 0; i < 5; i++) { const o = Number(await a.eval(SHOWN)); if (o > peak) peak = o; await ctx.sleep(50); }
  const gap = Number(await a.eval('window.__gapOn = false; window.__gap'));
  ctx.log(`real door: ${cell0} -> ${cell}, screen peak opacity ${peak.toFixed(2)}, longest frame ${gap.toFixed(0)} ms`);
  assert.notEqual(cell, cell0, 'door:enter must actually change cell for this half to mean anything');
  // A trip the engine loads in under 300 ms never freezes the page, and the screen rightly stays
  // down -- the same rule that keeps a refused door from flashing it (builder #223: a cached
  // interior, opacity 0, no freeze). A trip that DOES freeze the page must show it.
  assert.ok(peak > 0.5 || gap < 300, `the page froze ${gap.toFixed(0)} ms going through a door with no loading screen (opacity ${peak})`);
  assert.deepEqual(a.jsErrors(), [], 'no JS error');
}
