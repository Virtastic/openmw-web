// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s913: WHAT YOU LOOT STAYS LOOTED. Prod 2026-10-15: a player killed a mudcrab and took its crab
// meat; the server credited the take, then a world.spawn "by" the player debited it again and the
// meat was gone from the pack. s111 loots through the server directly (takenet); this one takes
// the way the game window does -- the corpse is activated, the item moves into the pack locally,
// and the container diff reports it (loot:<record>:<item>).
//
// Asserted: one more crab meat in the pack right after, and still 10 s later; no "[mp] drop:"
// line (a looted item reported as dropped from the pack).
//
// RETAIL DATA REQUIRED.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const managedPeer = true;
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const bootTimeoutMs = 420_000;
const MEAT = 'ingred_crab_meat_01';

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required)');
    return;
  }
  const a = await ctx.launchClient('looter', '', { retail: true, joinTimeoutMs: 420_000 });
  await ctx.sleep(5000);
  const count = async () => { await a.cmd(`count:${MEAT}`); await ctx.sleep(400); return Number(await a.eval('window.omw.state.count||"-1"')); };
  await a.cmd('hitn:mudcrab:200');
  await ctx.sleep(4000);
  const before = await count();
  await a.cmd(`loot:mudcrab:${MEAT}`);
  await a.waitFor('String(window.omw.state.lootTest||"").length > 0', 10_000, 'the loot command ran');
  const res = String(await a.eval('window.omw.state.lootTest'));
  ctx.log(`loot: ${res}, crab meat before ${before}`);
  assert.match(res, /^moved:[1-9]/, `nothing was looted (${res})`);
  const moved = Number(res.split(':')[1]);
  await ctx.sleep(1500);
  const after = await count();
  await ctx.sleep(10_000);
  const later = await count();
  ctx.log(`crab meat: before ${before}, just after ${after}, 10 s later ${later}`);
  const drops = a.logMatches(/\[mp\] drop:/);
  for (const l of a.logMatches(/\[mp\] (loot|drop):/)) ctx.log('  ' + l.slice(0, 200));
  assert.equal(after, before + moved, 'the looted meat is in the pack');
  assert.equal(later, before + moved, 'and still there 10 s later');
  assert.deepEqual(drops, [], 'nothing looted was reported as dropped');
  assert.deepEqual(a.luaErrors(), [], 'no Lua error');
}
