// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s192: THE TOWN STILL MOVES WHEN YOU COME BACK OUT. Prod 2026-10-17 (ar5tbvgs, Pelagiad): a player
// walked out of the fort and ~5 NPCs stood 200-500 u off for the rest of the session, ignoring
// the poses that kept arriving for them. Two faults (#161): the server dropped the interior from
// the peer's anchors before taking the player out of it, so the client heard "holder lost" and
// degraded every puppet (puppeted 34 -> 1); and a degraded puppet whose script was unloaded and
// reloaded came back with no key and AI off, frozen.
//
// Seyda Neen: count the puppets, go into the nearest building, wait long enough for the street's
// scripts to unload, come back out. Asserted: the puppet count did not collapse at the door, and
// no NPC with its own pose stream sits more than 150 u from it for 5 s running.
//
// RETAIL DATA REQUIRED.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const managedPeer = true;
export const bootTimeoutMs = 420_000;
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// Each probe NPC (one of its record in the cell, alive, a puppet) against its OWN newest pose
// (play/index.html tapKey: 'n<net>' for a runtime actor, '<contentFile>:<index>' for a content ref).
const OFF = `(function(){
  var pr = {}; try { pr = JSON.parse(window.omw.state.actorProbe || '{}'); } catch (e) {}
  var tap = window.__omwActorTap, now = Date.now(), out = {};
  function key(p){ if (p.net != null) return 'n' + p.net; if (typeof p.id !== 'string' || !/^0x[0-9a-f]+$/i.test(p.id)) return null;
    var v = parseInt(p.id, 16); return Math.floor(v / 16777216) + ':' + (v % 16777216); }
  for (var rec in pr) { var p = pr[rec]; if (rec === 'player' || !p || p.dead || (p.n || 1) !== 1 || !p.puppet) continue;
    var k = key(p), m = k && tap.last[k]; if (!m || now - m.t > 1000) continue;
    out[rec] = Math.round(Math.hypot(m.x - p.x, m.y - p.y)); }
  return JSON.stringify(out); })()`;

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required)');
    return;
  }
  const a = await ctx.launchClient('townie', '', { retail: true, joinTimeoutMs: 420_000 });
  await ctx.sleep(8000);
  const puppeted = async () => Number(await a.eval('window.omw.state.puppetedActors || "0"'));
  const cell = async () => String(await a.eval('String(window.omw.state.cell || "")'));
  const before = await puppeted();
  const street = await cell();
  ctx.log(`in ${street}: ${before} puppets`);
  assert.ok(before >= 5, `too few puppets on the street to judge (${before})`);

  await a.cmd('door:enter');
  await a.waitFor(`String(window.omw.state.cell || "") !== ${JSON.stringify(street)}`, 60_000, 'went indoors');
  const inside = await cell();
  ctx.log(`indoors: ${inside}`);
  await ctx.sleep(15_000); // the street's scripts unload (onSave) while we are gone

  await a.cmd('door:enter');
  await a.waitFor(`String(window.omw.state.cell || "") !== ${JSON.stringify(inside)}`, 60_000, 'back outside');
  await ctx.sleep(6000);
  const after = await puppeted();
  ctx.log(`back in ${await cell()}: ${after} puppets (before ${before})`);

  // 12 s of samples: an NPC is frozen if it stays > 150 u from its own pose for 5 s running.
  const run_ = {};
  let frozen = [];
  for (let i = 0; i < 12; i++) {
    const off = JSON.parse(await a.eval(OFF));
    for (const [rec, d] of Object.entries(off)) {
      run_[rec] = d > 150 ? (run_[rec] || 0) + 1 : 0;
      if (run_[rec] >= 5 && !frozen.includes(rec)) frozen.push(rec);
    }
    if (i === 0) ctx.log(`tracked NPCs: ${Object.keys(off).length}; offsets ${JSON.stringify(off).slice(0, 300)}`);
    await ctx.sleep(1000);
  }
  ctx.log(`frozen (>150 u from own pose for 5 s): ${frozen.length ? frozen.join(', ') : 'none'}`);
  assert.ok(after >= Math.floor(before * 0.6), `the puppets collapsed at the door: ${before} -> ${after}`);
  assert.deepEqual(frozen, [], 'NPCs stood still while their own poses arrived');
  assert.deepEqual(a.luaErrors(), [], 'no Lua error');
}
