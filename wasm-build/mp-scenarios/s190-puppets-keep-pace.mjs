// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s190: A WALKING CREATURE KEEPS PACE WITHOUT TELEPORTING. Prod 2026-10-16: an enemy "teleports
// around" in a fight. Traced (s990 diagnostic): a mudcrab the server walked at 34 u/s was drawn
// here at 23 u/s, fell 130-170 u behind, and puppet.lua's far-gap snap teleported it forward
// every ~10 s. getCurrentSpeed is a formula; a creature whose run animation carries it covers
// more ground, so the holder never set the run bit. actors.lua now sets it from the measured
// speed, and a puppet left 48 u behind runs. Before: 3 far snaps, p95 169 u; after: 0, p95 26 u.
//
// A mudcrab ~3000 u off is provoked (hitn) and walks to the player for 25 s. Sampled every
// 100 ms: the crab as the server sends it (page ws tap) and as this screen draws it (probe).
// Asserted: no far-gap snap, and the drawn crab within 96 u of the server's newest pose at p95
// (render delay and the 2 Hz probe's age account for ~25 u at this pace).
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
  const a = await ctx.launchClient('pacer', '', { retail: true, joinTimeoutMs: 420_000 });
  await ctx.sleep(5000);
  await a.cmd('hitn:mudcrab:1');
  await ctx.sleep(1000);
  await a.eval(`(function(){
    window.__tr = []; var tap = window.__omwActorTap;
    window.__trI = setInterval(function(){
      var pr = {}; try { pr = JSON.parse(window.omw.state.actorProbe||'{}'); } catch(e){}
      var c = pr.mudcrab; if (!c || c.dead) return;
      if (!window.__crabKey) { var bd = 200*200;
        for (var k in tap.last) { var r = tap.last[k]; if (Date.now()-r.t > 1000) continue; var d=(r.x-c.x)*(r.x-c.x)+(r.y-c.y)*(r.y-c.y); if (d<bd){bd=d;window.__crabKey=k;} } }
      var sv = window.__crabKey && tap.last[window.__crabKey];
      if (sv) window.__tr.push([Date.now(), sv.x, sv.y, c.x, c.y]);
    }, 100); return 1; })()`);
  await ctx.sleep(25_000);
  const tr = JSON.parse(await a.eval('clearInterval(window.__trI); JSON.stringify(window.__tr)'));
  let moved = 0;
  const off = [];
  for (let i = 1; i < tr.length; i++) {
    moved += Math.hypot(tr[i][1] - tr[i - 1][1], tr[i][2] - tr[i - 1][2]);
    off.push(Math.hypot(tr[i][1] - tr[i][3], tr[i][2] - tr[i][4]));
  }
  off.sort((x, y) => x - y);
  const p95 = off[Math.floor(off.length * 0.95)] ?? 0;
  const snaps = a.logMatches(/puppet far-gap snap/);
  ctx.log(`samples ${tr.length}, the server crab walked ${moved.toFixed(0)} u; drawn vs server p50 ${(off[off.length >> 1] ?? 0).toFixed(0)} p95 ${p95.toFixed(0)} max ${(off[off.length - 1] ?? 0).toFixed(0)}; far-gap snaps ${snaps.length}`);
  for (const l of snaps) ctx.log('  ' + l.slice(0, 200));
  assert.ok(tr.length >= 100, `too few samples of the crab (${tr.length})`);
  assert.ok(moved >= 300, `the crab barely walked (${moved.toFixed(0)} u): nothing to keep pace with`);
  assert.deepEqual(snaps, [], 'the walking crab was teleported to catch up');
  // 96: the crab speeds up and slows in a chase and the copy trails a step at each change, and the
  // probe is up to 0.5 s old (builder: p95 26-85 u across runs; 169 before the run bit).
  assert.ok(p95 < 96, `the drawn crab trailed the server's by ${p95.toFixed(0)} u at p95`);
  assert.deepEqual(a.luaErrors(), [], 'no Lua error');
}
