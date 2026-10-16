// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s191: EVERY JUMP THE PLAYER MAKES, THE AVATAR MAKES. Prod 2026-10-16: "jumping rock to rock we
// are rubberbanding back and forth". The avatar fired a jump the moment its input ARRIVED -- ahead
// of the queued movement, and while its own body might still be in the air from the last hop,
// where the engine ignores a jump. The owner hopped on; the avatar walked off the rock ("fell 60"
// in the peer log) and the owner was pulled back down. avatar.lua now fires the jump when its
// segment plays and holds it until the body is on the ground.
//
// The player runs and jumps again the moment they land, for 10 s. Counted: the player's own
// take-offs (pose z, 20 Hz) and the avatar's landings (the peer's fall probe). Asserted: the avatar
// made (nearly) every jump, and no hard snap pulled the player back.
//
// RETAIL DATA REQUIRED.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const managedPeer = true;
export const bootTimeoutMs = 420_000;
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required)');
    return;
  }
  const a = await ctx.launchClient('hopper', '', { retail: true, joinTimeoutMs: 420_000 });
  await ctx.sleep(6000);
  const landedBefore = String(ctx.serverLogTail(20000)).split('\n').filter((l) => /avatar #\d+ landed/.test(l)).length;
  await a.eval(`(function(){ window.__z = []; window.__zI = setInterval(function(){
    var p = null; try { p = JSON.parse(window.omw.state.pose||'null'); } catch(e){}
    if (p) window.__z.push(p.z); }, 50); return 1; })()`);
  // Run in a square so the ground stays the town's, jumping again as soon as we can.
  const t0 = Date.now();
  let leg = 0;
  while (Date.now() - t0 < 10_000) {
    if ((Date.now() - t0) / 2500 >= leg) {
      await a.cmd(`walk:${[[0, 1], [1, 0], [0, -1], [-1, 0]][leg % 4].join(',')},2500:run`);
      leg++;
    }
    await a.cmd('jump');
    await ctx.sleep(120);
  }
  await ctx.sleep(2500); // the last landing reaches the log
  const zs = JSON.parse(await a.eval('clearInterval(window.__zI); JSON.stringify(window.__z)'));
  // A take-off: z climbing > 4 u over 100 ms after having been level.
  let takeoffs = 0, air = false;
  for (let i = 2; i < zs.length; i++) {
    const rise = zs[i] - zs[i - 2];
    if (!air && rise > 4) { takeoffs++; air = true; } else if (air && rise <= 0) air = false;
  }
  const lines = String(ctx.serverLogTail(20000)).split('\n').filter((l) => /avatar #\d+ landed/.test(l));
  const landings = lines.length - landedBefore;
  const snaps = a.logMatches(/SELF SNAP/);
  ctx.log(`player take-offs ${takeoffs}, avatar landings ${landings}, self snaps ${snaps.length}`);
  for (const l of lines.slice(-6)) ctx.log('  ' + l.replace(/^.*\[mp\]/, '[mp]').slice(0, 160));
  assert.ok(takeoffs >= 6, `the player barely jumped (${takeoffs})`);
  assert.ok(landings >= Math.floor(takeoffs * 0.8), `the avatar made ${landings} of the player's ${takeoffs} jumps`);
  assert.deepEqual(snaps, [], 'a hard snap pulled the hopping player back');
  assert.deepEqual(a.luaErrors(), [], 'no Lua error');
}
