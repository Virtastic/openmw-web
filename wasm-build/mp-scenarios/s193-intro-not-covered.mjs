// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s193: THE INTRO IS SHOWN, NOT COVERED. A new game plays Morrowind's opening movie before the
// game starts, and the multiplayer join only comes after it; the loading screen used to stay over
// the canvas for the whole movie, so a new player sat on "Loading Morrowind" for a minute hearing
// it play (prod 2026-10-21: first frame at 11 s, connecting at 69 s). The engine flags a playing
// video (Module.__omwVideo) and the screen steps aside for it; the boot timeline records both edges.
// Every other scenario boots with novid&skipintro. RETAIL DATA REQUIRED (Video/*.bik).
import assert from 'node:assert/strict';

export const windowSize = '1280,720';
export const bootTimeoutMs = 420_000;

export default async function run(ctx) {
  const a = await ctx.launchClient('intro', '', { retail: true, newGame: true, intro: true, joinTimeoutMs: 420_000 });
  const boot = JSON.parse(String(await a.eval('JSON.stringify(window.__omwBoot || {})')));
  ctx.log(`boot timeline: ${JSON.stringify(boot)}`);
  assert.ok(boot.videoStart !== undefined, 'the loading screen never stepped aside for a video');
  assert.ok(boot.videoEnd !== undefined && boot.videoEnd > boot.videoStart, 'the screen did not come back after the video');
  assert.ok(boot.netConnecting === undefined || boot.videoEnd <= boot.netConnecting + 1000,
    'the join started while the movie was still playing');
  ctx.log(`the intro played uncovered for ${Math.round((boot.videoEnd - boot.videoStart) / 1000)} s`);
}
