// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s65: RENDER CHECK. Boots retail in Seyda Neen and captures frames for the reported rendering
// faults -- "texture transparency not working, alpha renders opaque, most visible on trees" and
// "minimap texture corruption, solid white/blue/black".
//
// Asserted: the world frame is a rendered scene (many colours, no single colour dominating, not
// black or white), the HUD frame too, and the GL layer raised no framebuffer error while
// drawing them. NOT asserted: whether foliage alpha is right -- a pixel verdict on that would be
// a guess dressed as a test. The PNGs stay for a person to read.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
// harness-out, not the checkout root: the root is not writable by the harness uid (#111).
const OUT = join(ROOT, 'wasm-build', 'harness-out');
export const bootTimeoutMs = 420_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };

const scene = (what, f) => {
  assert.ok(f.colours > 200 && f.dominant < 0.5 && f.meanLum > 8 && f.meanLum < 245,
    `${what} is not a rendered scene: ${f.colours} colours, ${Math.round(f.dominant * 100)}% rgb(${f.dominantRgb}), mean luminance ${Math.round(f.meanLum)}`);
};

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required)');
    return;
  }
  mkdirSync(OUT, { recursive: true });
  // Seyda Neen: trees and foliage in view, which is where the alpha fault was reported.
  const c = await ctx.launchClient('eyes', '', BOOT);
  await c.dismissTour();
  await ctx.sleep(6000); // let the cell finish streaming in before looking at it

  const world = await c.frameStats(undefined, join(OUT, 'render-check-world.png'));
  ctx.log(`world frame: ${JSON.stringify(world)}`);
  scene('the world frame', world);

  await ctx.sleep(3000);
  const hud = await c.frameStats(undefined, join(OUT, 'render-check-hud.png'));
  ctx.log(`hud frame: ${JSON.stringify(hud)}`);
  scene('the HUD frame', hud);

  const NL = new RegExp(String.fromCharCode(92) + 'r?' + String.fromCharCode(92) + 'n');
  const gl = [...new Set((c.logTail?.(1000000) ?? '').split(NL)
    .filter((l) => /framebuffer incomplete|GL_INVALID_FRAMEBUFFER|Error attaching FBO/i.test(l)).map((l) => l.trim()))];
  for (const l of gl.slice(0, 10)) ctx.log(`  GL: ${l.slice(0, 200)}`);
  assert.equal(gl.length, 0, 'the GL layer reported a framebuffer error while rendering');
  ctx.log('NOT ASSERTED: foliage alpha. Read render-check-world.png: the fault shows as opaque quads around leaves.');
}
