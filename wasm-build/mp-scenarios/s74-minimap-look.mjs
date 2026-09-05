// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s74: capture the HUD so the MINIMAP can actually be looked at.
//
// The minimap rendering solid white/blue/black has sat undiagnosed with a list of eliminated
// suspects and no way to check the remaining one. The local map is drawn to a render target,
// and localmap.cpp asked for FRAME_BUFFER_OBJECT with PIXEL_BUFFER_RTT as its FALLBACK -- and
// a pbuffer does not exist under WebGL at all, so anything declining the FBO path landed on
// something that cannot work and drew garbage instead of failing loudly. That fallback is gone
// now.
//
// This scenario does not assert the minimap is CORRECT -- no automated check can tell a
// plausible map from a wrong one, and pretending otherwise would be worse than not looking.
// What it does is produce the artefact a person can look at in one step, instead of the bug
// staying "undiagnosed" because checking it was a whole afternoon of setup.
//
// The minimap is part of the HUD, so ordinary gameplay is enough; no UI has to be opened.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Written into the REPO, not /tmp. The harness runs in a --rm container, so anything left in
// its own /tmp dies with it -- the first version of this produced the screenshot and threw it
// away. The repo is the bind mount, so this lands on the host where a person can open it.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export default async function run(ctx) {
  const a = await ctx.launchClient('map-look');

  // Let the world settle. The local map renders as cells load, and a shot taken during the
  // first frames says nothing about whether the RTT path works.
  await ctx.sleep(8000);
  const before = await a.screenshot(join(ROOT, 'minimap-before-walk.png'));

  // WALK FIRST, then look again. The map panel on a character who has just spawned shows
  // unexplored FOG OF WAR, which in Morrowind is a flat tan field -- indistinguishable in a
  // screenshot from "the map never draws", and the first version of this scenario captured
  // exactly that and nearly reported it as the bug. Fog lifts where the player has been, so a
  // walked character is the only one whose map means anything.
  //
  // Two shots, deliberately: if the panel is identical before and after a walk, fog is not
  // lifting or the map is not drawing; if it changes, both are working and the reported bug is
  // something else or is gone.
  await a.eval("window.omw.send('walk:0,1,20000')");
  await ctx.sleep(22000);

  const after = await a.screenshot(join(ROOT, 'minimap-after-walk.png'));

  // THE FULL MAP WINDOW, as a discriminator the HUD panel alone cannot give. Both widgets read
  // the SAME per-cell texture (LocalMap::getMapTexture) through different MyGUI widgets, so:
  //   * window draws the cell, HUD panel blank -> the texture HAS content and the fault is the
  //     small widget;
  //   * both blank -> nothing is being drawn into the texture at all, and the widget layer is
  //     exonerated.
  // The texture pointer is already proven identical at setup and at draw, so this is the next
  // link in the chain and the only one still unmeasured.
  await a.eval("window.omw.send('ui:Map')");
  await ctx.sleep(3000);
  const win = await a.screenshot(join(ROOT, 'minimap-window.png'));
  ctx.log(`  map WINDOW: ${win}`);
  ctx.log(`  before walking: ${before}`);
  ctx.log(`  after walking:  ${after}`);
  ctx.log('  compare the map panel in the HUD corner -- identical means it never drew');

  // PRINT THE ENGINE'S OWN LINES. The harness only dumps a client's console when a scenario
  // FAILS, and this one passes by design -- it produces artefacts rather than asserting. So
  // the local-map diagnostics went into a log nobody read, and their absence looked like
  // evidence when it was just a log that was never shown.
  const lines = (a.logTail?.(400) ?? '').split('\n').filter((l) => /Local map:/i.test(l));
  ctx.log(`  local-map diagnostics (${lines.length}):`);
  for (const l of lines.slice(0, 6)) ctx.log(`    ${l.trim()}`);
  if (!lines.length) ctx.log('    none — neither the RTT camera nor the null-texture path was reached');

  // GL-LEVEL COMPLAINTS. The map camera is created, traversed, culls 109 drawables and its draw
  // executes, and the target STILL reads back as zero even when the clear colour is bright blue.
  // A clear that does not land is the signature of an INCOMPLETE FRAMEBUFFER: the stage runs,
  // the driver rejects it, and nothing is written. OSG and the WebGL layer both say so out loud
  // -- and this scenario was throwing those lines away, because it only ever grepped for its own
  // "Local map:" prefix. Printing what the GL layer says is free and it is the only remaining
  // place the answer can come from.
  const NL = new RegExp(String.fromCharCode(92) + 'r?' + String.fromCharCode(92) + 'n');
  // THE WHOLE LOG, not a tail. logTail(n) returns the LAST n lines, and an FBO/attachment error
  // happens at the FIRST render -- early in a boot that goes on to log far more than 4000
  // lines. So the previous "GL-level complaints (0 distinct)" may simply have been looking
  // past the only window the error could appear in, and reporting silence as evidence.
  //
  // That matters because the peer image DID log 'Error attaching FBO' in the same family of
  // run, and because the panel is BLACK while this camera clears to BLUE: a clear that never
  // lands is what an unattached framebuffer looks like from the outside.
  const all = a.logTail?.(1000000) ?? '';
  const gl = [...new Set(all.split(NL)
    .filter((l) => /framebuffer|incomplete|GL_INVALID|FBO|glCheckFramebuffer|RenderStage/i.test(l))
    .map((l) => l.trim()))];
  ctx.log(`  GL-level complaints (${gl.length} distinct):`);
  for (const l of gl.slice(0, 20)) ctx.log(`    ${l.slice(0, 200)}`);
  if (!gl.length) ctx.log('    none — the framebuffer is not complaining, so incompleteness is NOT the cause');
}
