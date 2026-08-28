// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s76: one loading overlay per area change, not two.
//
// Reported from actual play: the loading screen comes up, the game appears, the loading screen
// FLASHES A SECOND TIME, and the game appears again. The overlay is ours -- a web-only addition,
// because a cell load blocks the emscripten main loop and OpenMW's own loading screen draws
// frames the browser never composites -- so the double flash is ours too.
//
// The cause is that the guard against it could not work. `signalCellLoad` debounced on TIME,
// measured from when the overlay was shown, with the cell load happening inside that window: the
// load blocks the main loop for seconds, so the echo always arrived after the 2 s debounce had
// expired. A guard that is structurally unable to observe the event it guards against is worse
// than none, because it reads as covered.
//
// This asserts on the SEQUENCE COUNTER the Lua side publishes rather than on pixels: one door
// use must advance `cellLoad` exactly once. Counting overlay appearances in screenshots would
// be flakier and would not say which layer was wrong.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOOT = { retail: true, joinTimeoutMs: 420_000, startCell: 'Seyda Neen' };

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (needs real teleport doors)');
    return;
  }
  const c = await ctx.launchClient('cellload', '', BOOT);

  const seq = async () => Number(await c.eval("Number((window.__omwMP||{}).cellLoad||0)"));

  const before = await seq();
  ctx.log(`  cellLoad starts at ${before}`);

  // A real teleport door in Seyda Neen. Activating it is the exact path a player takes, and it
  // is what raises the signal -- the handler fires on ACTIVATION, before the teleport, so the
  // overlay is on screen before the main loop blocks.
  // JSON.stringify the whole command: this door id contains an APOSTROPHE and hand-quoting
  // it broke the eval outright ("Unexpected identifier 's'"). Morrowind cell and record ids
  // are full of apostrophes, so build the string rather than quoting by eye.
  const DOOR = "seyda neen, arrille's tradehouse";
  await c.eval("Module.__omwMPCmd=" + JSON.stringify("dlg:" + DOOR));
  await ctx.sleep(1500);

  // Watch across the WHOLE load and well past it. The echo arrives after arrival, which is
  // precisely where the old time-based guard had already given up -- so a short window here
  // would reproduce the same blindness the fix is about.
  const seen = [];
  const until = Date.now() + 25_000;
  while (Date.now() < until) {
    const n = await seq();
    if (!seen.includes(n)) { seen.push(n); ctx.log(`  cellLoad -> ${n} at +${((Date.now() - (until - 25000)) / 1000).toFixed(1)}s`); }
    await ctx.sleep(500);
  }

  const advanced = (await seq()) - before;
  ctx.log(`  cellLoad advanced by ${advanced} across one door use`);
  assert.ok(advanced <= 1,
    `the loading overlay was raised ${advanced} times for ONE area change -- this is the double`
    + ` flash. Values seen: ${JSON.stringify(seen)}`);
  ctx.log('  ok: one overlay per area change');
}
