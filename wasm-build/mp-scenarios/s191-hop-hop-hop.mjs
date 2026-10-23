// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s191: HOPPING DOES NOT RUBBER-BAND. Prod 2026-10-16: "jumping rock to rock we are rubberbanding
// back and forth". Our jump and the avatar's are two physics runs of one arc, a frame or two apart;
// mid-arc they disagree by tens of units, and reconciliation tugged the player toward the avatar's
// arc on every sample of every hop. player.lua no longer corrects against a moment in the air (a
// hop, not levitation); the landing settles it. Also: only a jump the engine makes is sent.
//
// The player runs and jumps again the moment they land, for 10 s. Measured: how far reconciliation
// pulled the player in all (selfCorrPath). Old code: 376-913 u (four runs); new: 85-304 u (three).
// Asserted: under 400 u, no hard snap, and the avatar still made (nearly) every jump.
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
    if (p) window.__z.push(p.z);
    var d = parseFloat(window.omw.state.selfDivergence); if (!isNaN(d)) window.__dv.push(d); }, 50); window.__dv = []; return 1; })()`);
  const pulled = async () => Number(await a.eval('window.omw.state.selfCorrPath||"0"'));
  const pull0 = await pulled();
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
  // THE RUBBER BAND ITSELF: how far the peer's pose sat from where we stood at that input.
  const dv = JSON.parse(await a.eval('JSON.stringify(window.__dv)')).sort((x, y) => x - y);
  const q = (f) => dv.length ? dv[Math.min(dv.length - 1, Math.floor(f * dv.length))] : 0;
  // A take-off: z climbing > 12 u over 100 ms -- a jump's lift. Running up a slope or a step
  // climbs a few units in that time and is not one (a 4 u rule counted 21 'jumps' for 13 real).
  let takeoffs = 0, air = false;
  for (let i = 2; i < zs.length; i++) {
    const rise = zs[i] - zs[i - 2];
    if (!air && rise > 12) { takeoffs++; air = true; } else if (air && rise <= 0) air = false;
  }
  const lines = String(ctx.serverLogTail(20000)).split('\n').filter((l) => /avatar #\d+ landed/.test(l));
  const landings = lines.length - landedBefore;
  const snaps = a.logMatches(/SELF SNAP/);
  const pull = (await pulled()) - pull0;
  ctx.log(`player take-offs ${takeoffs}, avatar landings ${landings}, self snaps ${snaps.length}; pulled ${pull.toFixed(0)} u in all; divergence p50 ${q(0.5).toFixed(1)} p95 ${q(0.95).toFixed(1)} max ${q(1).toFixed(1)} (n=${dv.length})`);
  for (const l of lines.slice(-6)) ctx.log('  ' + l.replace(/^.*\[mp\]/, '[mp]').slice(0, 160));
  assert.ok(takeoffs >= 6, `the player barely jumped (${takeoffs})`);
  // Under the WoW model the avatar is PLACED on the player's poses and never jumps by itself, so
  // its own landings say nothing; the bar is that nothing pulled the player back at all.
  const wow = (await a.eval("String(window.omw.state.clientAuthority||'')")) === 'true';
  if (!wow) assert.ok(landings >= Math.floor(takeoffs * 0.7), `the avatar made ${landings} of the player's ${takeoffs} jumps`);
  else assert.ok(pull < 50, `the WoW model pulled the hopping player ${pull.toFixed(0)} u`);
  assert.ok(pull < 400, `reconciliation pulled the hopping player ${pull.toFixed(0)} u (old code: 376-913)`);
  assert.deepEqual(snaps, [], 'a hard snap pulled the hopping player back');
  assert.deepEqual(a.luaErrors(), [], 'no Lua error');
}
