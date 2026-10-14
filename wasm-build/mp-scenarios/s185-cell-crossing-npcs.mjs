// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s185: WALKING INTO THE NEXT CELL, THE NPCS STAY WHERE THEY ARE. Prod telemetry (1.5.2, 9
// sessions, 435 windows) put NPCs a median 6 u from the path the server sent, with every window
// over 60 u the FIRST one after entering a cell (-2,-9 -> -3,-9: npcPath p50 752 u, n=4). This
// measures exactly that: a player walks from Seyda Neen west across the -2,-9 / -3,-9 line while
// the page's own npcPath (index.html telemetry: the drawn NPC against the poses received over the
// last 2 s, point-to-segment) is sampled every half second, before and after the crossing.
//
// Logged per second, so the size and length of any crossing pop is data. Asserted: after the
// crossing settles (5 s), NPCs in the new cell are on their streamed paths (p95 < 64 u).
//
// RETAIL DATA REQUIRED.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const managedPeer = true;
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
export const bootTimeoutMs = 420_000;
const EDGE_X = -16384; // the -2 / -3 cell line

// The page's npcPath for the current frame: per drawn (probe) actor, the distance to the nearest
// segment of any actor's received-pose history within 2 s. Returns the distances.
const PATH_EXPR = `(function(){
  var tap = window.__omwActorTap || {}, hist = tap.hist || {}, now = Date.now(), out = [];
  var probe = JSON.parse(window.omw.state.actorProbe || '{}');
  for (var rec in probe) {
    var p = probe[rec];
    if (rec === 'player' || !p || p.dead || (p.n || 1) !== 1) continue;
    var best = Infinity;
    for (var k in hist) { var h = hist[k];
      for (var j = 0; j < h.length; j++) { if (now - h[j].t > 2000) continue;
        var a = h[j], b = h[j + 1] && now - h[j + 1].t <= 2000 ? h[j + 1] : a;
        var ex = b.x - a.x, ey = b.y - a.y, len = ex * ex + ey * ey;
        var u = len > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / len)) : 0;
        var qx = a.x + u * ex - p.x, qy = a.y + u * ey - p.y, d = qx * qx + qy * qy; if (d < best) best = d; } }
    if (best < 1024 * 1024) out.push(Math.round(Math.sqrt(best)));
  }
  return JSON.stringify({ cell: window.omw.state.cell, holder: window.omw.state.authorityHolder, pup: window.omw.state.puppetedActors, gaps: out });
})()`;
const q = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required)');
    return;
  }
  const a = await ctx.launchClient('crosser', '', BOOT);
  await a.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 300_000, 'the peer holds Seyda Neen (puppets attached)');
  // Stand 250 u east of the line, facing west.
  const me0 = JSON.parse(await a.eval('window.omw.state.pose||"{}"'));
  await a.cmd(`snapto:${EDGE_X + 250},${Math.round(me0.y)},${Math.round(me0.z + 200)}`);
  await ctx.sleep(6_000);
  const me = JSON.parse(await a.eval('window.omw.state.pose||"{}"'));
  await a.cmd(`face:${EDGE_X - 2000},${Math.round(me.y)},${Math.round(me.z + 50)}`);
  await ctx.sleep(1_000);
  ctx.log(`start: (${Math.round(me.x)},${Math.round(me.y)}) cell=${await a.eval('window.omw.state.cell')}`);

  const before = [], after = [], perSec = [];
  let crossedAt = null;
  // Walk west for ~6 s (crosses at ~1-2 s), then stand 12 s in the new cell.
  // The walk hook can be swallowed on the first frames after a snap (the first builder run never
  // moved; its retry crossed at 4 s): send it again until the pose actually leaves the start.
  for (let tries = 0; tries < 4; tries++) {
    await a.cmd('walk:0,1,6000:run');
    await ctx.sleep(1_500);
    const x = JSON.parse(await a.eval('window.omw.state.pose||"{}"')).x;
    if (Math.abs(x - me.x) > 50) break;
    ctx.log(`  walk did not start (x=${Math.round(x)}); again`);
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 18_000) {
    const s = JSON.parse(await a.eval(PATH_EXPR));
    const x = JSON.parse(await a.eval('window.omw.state.pose||"{}"')).x;
    if (crossedAt === null && x < EDGE_X) crossedAt = Date.now();
    const sec = Math.floor((Date.now() - t0) / 1000);
    (perSec[sec] ??= { cell: s.cell, holder: s.holder, pup: s.pup, g: [] }).g.push(...s.gaps);
    if (crossedAt === null) before.push(...s.gaps);
    else if (Date.now() - crossedAt > 5_000) after.push(...s.gaps);
    await ctx.sleep(500);
  }
  perSec.forEach((r, i) => r && ctx.log(`  t=${i}s cell=${r.cell} holder=${r.holder} pup=${r.pup} npcs=${r.g.length} p50=${q(r.g, 0.5)} max=${q(r.g, 1)}`));
  ctx.log(`crossed: ${crossedAt ? `${((crossedAt - t0) / 1000).toFixed(1)} s in` : 'NEVER'}; before p95=${q(before, 0.95)} (n=${before.length}); settled after p95=${q(after, 0.95)} max=${q(after, 1)} (n=${after.length})`);
  assert.ok(crossedAt, 'the walk never crossed into -3,-9');
  assert.ok(after.length > 0, 'no NPC sampled in the new cell after the crossing');
  assert.ok(q(after, 0.95) < 64, `NPCs in the new cell are off their streamed paths 5 s after the crossing (p95 ${q(after, 0.95)} u)`);
  assert.deepEqual(a.luaErrors(), [], 'no Lua error');
}
