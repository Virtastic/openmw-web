// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s188: WALKING NPCS FACE THE WAY THEY WALK. Prod 2026-10-14: NPCs "doing 180s as they walk"
// while every position metric read 1-3 u -- a puppet a step AHEAD of its walking target steered
// back at it, a bearing ~180 degrees off the walk (puppet.lua, fixed in #141). Positions cannot
// show it, so the page counts it: each walking NPC (server speed > 20 u/s) drawn within 64 u of
// the server's pose but facing more than 120 degrees off the server's heading
// (window.__omwNpcFacing, the same count telemetry ships as npcFacing).
//
// Only while the server heading is STEADY (within 45 degrees over 2 s): a real turn at the
// end of a path reads as turned round for the render delay (11 of 15 such in the first run).
//
// Seyda Neen for 45 s with the player walking about (three runs: 0/138, 0/105, 2/163). Asserted: enough walking samples to mean
// something, and under 2% of them turned round.
//
// RETAIL DATA REQUIRED.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const managedPeer = true;
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const bootTimeoutMs = 420_000;

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required)');
    return;
  }
  const a = await ctx.launchClient('facer', '', { retail: true, joinTimeoutMs: 420_000 });
  await ctx.sleep(5_000);
  const read = async () => JSON.parse(await a.eval('JSON.stringify(window.__omwNpcFacing || { n: 0, bad: 0 })'));
  const t0 = Date.now();
  for (let i = 0; Date.now() - t0 < 45_000; i++) {
    await a.cmd(`walk:${[[1, 0], [0, 1], [-1, 0], [0, -1]][i % 4].join(',')},3500`);
    await ctx.sleep(4_000);
  }
  const f = await read();
  const pct = f.n ? (100 * f.bad) / f.n : 0;
  ctx.log(`walking NPC samples ${f.n}, turned round ${f.bad} (${pct.toFixed(1)}%)`);
  for (const b of (f.bads || [])) ctx.log('  turned round: ' + JSON.stringify(b));
  assert.ok(f.n >= 20, `too few walking-NPC samples to judge (${f.n})`);
  assert.ok(pct < 2, `walking NPCs drawn turned round in ${pct.toFixed(1)}% of samples (${f.bad}/${f.n})`);
  assert.deepEqual(a.luaErrors(), [], 'no Lua error');
}
