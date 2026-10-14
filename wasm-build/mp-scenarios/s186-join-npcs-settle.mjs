// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s186: WHEN THE LOADING SCREEN CLEARS, THE NPCS ARE ALREADY WHERE THE SERVER HAS THEM.
// Prod (2026-10-14, session t5byrpz0): a rejoin into Seyda Neen, holder=2 and 30-35 batches/s,
// and still p50 ~200 u between the drawn NPCs and the paths the server streamed, for 20 s. The
// loading screen hides on "holder named + a batch received" (#134), not "NPCs placed".
//
// Measured from the moment the loading screen clears, on the first join and again after a page
// reload (the rejoin): per second, the page's npcPath distance for every drawn NPC (s185's
// expression). Logged in full; asserted: within 3 s of the screen clearing, p50 < 32 u.
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

const PATH_EXPR = `(function(){
  var tap = window.__omwActorTap || {}, hist = tap.hist || {}, now = Date.now(), out = [];
  var probe = JSON.parse((window.omw && window.omw.state && window.omw.state.actorProbe) || '{}');
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
  var st = (window.omw && window.omw.state) || {};
  return JSON.stringify({ holder: st.authorityHolder, pup: st.puppetedActors, ab: st.actorBatchesIn, gaps: out });
})()`;
const CLEARED = "(function(){var el=document.getElementById('loading');return !el || el.classList.contains('hide') || el.style.display === 'none';})()";
const q = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

async function watch(ctx, c, label) {
  const t0 = Date.now(), perSec = [];
  while (Date.now() - t0 < 25_000) {
    const s = JSON.parse(await c.eval(PATH_EXPR));
    const sec = Math.floor((Date.now() - t0) / 1000);
    (perSec[sec] ??= { holder: s.holder, pup: s.pup, ab: s.ab, g: [] }).g.push(...s.gaps);
    await ctx.sleep(500);
  }
  perSec.forEach((r, i) => r && ctx.log(`  ${label} t=${i}s holder=${r.holder} pup=${r.pup} batches=${r.ab} npcs=${r.g.length} p50=${q(r.g, 0.5)} max=${q(r.g, 1)}`));
  const early = perSec.slice(0, 3).flatMap((r) => (r ? r.g : []));
  const settledAt = perSec.findIndex((r) => r && r.g.length > 0 && q(r.g, 0.5) < 32);
  ctx.log(`${label}: first 3 s p50=${q(early, 0.5)} (n=${early.length}); first second with p50 < 32 u: ${settledAt}`);
  return { early, settledAt };
}

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required)');
    return;
  }
  const a = await ctx.launchClient('settler', '', BOOT);
  const first = await watch(ctx, a, 'join');
  await a.reload();
  await a.waitFor(CLEARED, 120_000, 'the loading screen cleared after the rejoin');
  const again = await watch(ctx, a, 'rejoin');
  for (const [label, r] of [['join', first], ['rejoin', again]]) {
    assert.ok(r.early.length > 0, `${label}: no NPC drawn in the first 3 s after the screen cleared`);
    assert.ok(q(r.early, 0.5) < 32, `${label}: NPCs still off their server paths when the screen cleared (first 3 s p50 ${q(r.early, 0.5)} u; settled at ${r.settledAt} s)`);
  }
  assert.deepEqual(a.luaErrors(), [], 'no Lua error');
}
