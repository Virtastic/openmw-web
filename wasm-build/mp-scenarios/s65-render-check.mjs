// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s65: RENDER CHECK. Boots retail and captures frames for the reported rendering faults —
// "texture transparency not working, alpha renders opaque, most visible on trees" and "minimap
// texture corruption, solid white/blue/black".
//
// Neither is decidable by reading: the alpha-test machinery in shadervisitor.cpp and
// lib/material/alpha.glsl is intact and correct on inspection, and the minimap is a
// render-to-texture path. The only honest way to answer them is to look at a frame.
//
// This scenario does not ASSERT anything about the image — a pass/fail on pixel content would be
// a guess dressed as a test. It captures, and a human (or the next session) reads the file.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const bootTimeoutMs = 420_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required)');
    return;
  }
  // Seyda Neen: trees and foliage in view, which is where the alpha fault was reported.
  const c = await ctx.launchClient('eyes', '', BOOT);
  await ctx.sleep(6000); // let the cell finish streaming in before looking at it

  const shot = join(ROOT, 'render-check-world.png');
  await c.screenshot(shot);
  ctx.log(`captured ${shot}`);

  // The minimap lives in the HUD. Nothing here forces it open — it is on by default — so this
  // is the same frame, kept separate so the two questions are not confused.
  const shot2 = join(ROOT, 'render-check-hud.png');
  await ctx.sleep(3000);
  await c.screenshot(shot2);
  ctx.log(`captured ${shot2}`);
  ctx.log('NOT ASSERTED: read the PNGs. Alpha fault shows as opaque quads around foliage; '
    + 'minimap fault shows as a flat white/blue/black panel.');
}
