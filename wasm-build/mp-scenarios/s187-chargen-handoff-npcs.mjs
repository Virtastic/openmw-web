// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s187: FINISHING CHARACTER CREATION, THE TOWN'S NPCS DO NOT DRIFT. A character in creation stands
// in cells nobody holds (the opening's scripts must run on the player's own engine; worldstate.ts
// hasPlayerInChargen), so the browser runs Seyda Neen's NPCs itself. When creation ends the peer
// takes the cell over and every NPC becomes a puppet of the peer's copy. Prod (2026-10-14, session
// t5byrpz0, 16:18:28 character.created): for 20 s after that, NPCs drawn p50 ~200 u from the paths
// the peer streamed. No loading screen covers this moment: the player is walking.
//
// A REAL new game (mpnew=1, s183's boot), out through the ship's hatch into the Seyda Neen exterior
// while still in creation, 15 s of the browser's own town, then creation ends (chargenstate -1, the
// census office's exit script) and the page's npcPath (s185/s186) is sampled every half second for
// 25 s from the takeover. Asserted: within 3 s of the takeover, p50 < 32 u.
//
// RETAIL DATA REQUIRED.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const managedPeer = true;
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BOOT = { retail: true, newGame: true, joinTimeoutMs: 420_000 };
export const bootTimeoutMs = 420_000;
const ESC = { key: 'Escape', code: 'Escape', keyCode: 27, text: '' };

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
const q = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const st = async (c, k) => String(await c.eval(`String(window.omw.state.${k}||'')`));

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required)');
    return;
  }
  // A provisional id, as the launcher gives a new character: the server then has this player IN
  // creation (conn.chargen_state inChargen=true) and evicts the peer from their cell, as on prod.
  const charId = 'c' + randomBytes(12).toString('hex');
  const a = await ctx.launchClient('fresh', '', { ...BOOT, charId });
  await a.dismissTour(15_000);
  assert.notEqual(await st(a, 'chargenDone'), '1', 'a fresh slot must start IN character creation');
  // Close what the opening has up (a forced greeting, a message box), then out of the hatch.
  for (let tries = 0; tries < 6 && !/^-?\d+,-?\d+$/.test(await st(a, 'cell')); tries++) {
    for (let i = 0; i < 4 && (await st(a, 'uiMode')) !== 'none' && (await st(a, 'uiMode')) !== ''; i++) {
      await a.eval(`document.getElementById('canvas').focus()`);
      await a.key(ESC);
      await ctx.sleep(800);
    }
    await a.cmd('door:enter');
    await ctx.sleep(5_000);
    ctx.log(`  try ${tries}: cell=${await st(a, 'cell')} uiMode=${await st(a, 'uiMode')}`);
  }
  const cell = await st(a, 'cell');
  assert.match(cell, /^-?\d+,-?\d+$/, `never reached the Seyda Neen exterior (still in "${cell}")`);
  ctx.log(`in creation outdoors: cell=${cell} chargenDone=${await st(a, 'chargenDone')} holder=${await st(a, 'authorityHolder')} puppeted=${await st(a, 'puppetedActors')}`);
  assert.equal((await st(a, 'authorityHolder')) || 'none', 'none', 'the server must leave a creating player\'s cell unheld (the chargen sanctuary)');
  await ctx.sleep(15_000); // the browser's own town, as through the opening walk

  await a.cmd('gvar:chargenstate:-1');
  await a.waitFor('window.omw.state.chargenDone === "1"', 30_000, 'creation ended');
  const tEnd = Date.now();
  try {
    await a.waitFor('(window.omw.state.authorityHolder||"none") !== "none" && Number(window.omw.state.puppetedActors||0) > 0', 60_000, 'the peer took the town over');
  } finally {
    ctx.log(`after creation: holder=${await st(a, 'authorityHolder')} puppeted=${await st(a, 'puppetedActors')}`);
    for (const l of String(ctx.serverLogTail(3000)).split('\n')
      .filter((l) => /chargen|ChargenComplete|character\.created|simpeer\.anchors|authority\.|-2,-9/.test(l)).slice(-25)) ctx.log('  srv ' + l.slice(0, 300));
  }
  ctx.log(`takeover ${((Date.now() - tEnd) / 1000).toFixed(1)} s after creation ended`);

  const t0 = Date.now(), perSec = [];
  while (Date.now() - t0 < 25_000) {
    const s = JSON.parse(await a.eval(PATH_EXPR));
    const sec = Math.floor((Date.now() - t0) / 1000);
    (perSec[sec] ??= { holder: s.holder, pup: s.pup, ab: s.ab, g: [] }).g.push(...s.gaps);
    await ctx.sleep(500);
  }
  perSec.forEach((r, i) => r && ctx.log(`  t=${i}s holder=${r.holder} pup=${r.pup} batches=${r.ab} npcs=${r.g.length} p50=${q(r.g, 0.5)} max=${q(r.g, 1)}`));
  const early = perSec.slice(0, 3).flatMap((r) => (r ? r.g : []));
  const settledAt = perSec.findIndex((r) => r && r.g.length > 0 && q(r.g, 0.5) < 32);
  ctx.log(`first 3 s p50=${q(early, 0.5)} (n=${early.length}); first second with p50 < 32 u: ${settledAt}`);
  assert.ok(early.length > 0, 'no NPC drawn after the takeover');
  assert.ok(q(early, 0.5) < 32, `NPCs drift after creation ends (first 3 s p50 ${q(early, 0.5)} u; settled at ${settledAt} s)`);
  assert.deepEqual(a.luaErrors(), [], 'no Lua error');
}
