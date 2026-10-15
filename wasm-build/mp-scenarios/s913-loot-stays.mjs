// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s913: WHAT YOU LOOT STAYS LOOTED, AND NOTHING YOU DID NOT TAKE IS CREDITED. Prod 2026-10-15: a
// player killed a mudcrab and its crab meat ended up credited and then taken away again. Cause:
// each engine rolls a dead creature's loot itself; when the holder's copy is made canonical the
// client sheds what its own roll had extra, and the corpse watch reported that shedding as the
// player's TAKE -- loot nobody held, credited, then reconciled away. A take is now the corpse
// going down AND the pack going up (objects.lua diffContainer).
//
// s111 loots through the server directly (takenet); this takes the way the game window does --
// the corpse is activated, an item moves into the pack locally, the container diff reports it
// (loot:<record>:* takes whatever the canonical corpse actually holds).
//
// Asserted: the looted item is in the pack right after and still 10 s later; every reported take
// is of the item that moved; nothing looted is reported as dropped.
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
  const a = await ctx.launchClient('looter', '', { retail: true, joinTimeoutMs: 420_000 });
  await ctx.sleep(5000);
  const count = async (id) => { await a.cmd(`count:${id}`); await ctx.sleep(400); return Number(await a.eval('window.omw.state.count||"-1"')); };
  await a.cmd('hitn:mudcrab:200');
  await ctx.sleep(5000);
  await a.cmd('loot:mudcrab:*');
  await a.waitFor('String(window.omw.state.lootTest||"").length > 0', 10_000, 'the loot command ran');
  const res = String(await a.eval('window.omw.state.lootTest'));
  const item = String(await a.eval('window.omw.state.lootItem||""'));
  // moveInto zeroes the moved object's own count, so 'moved:N' can read 0 after a real move;
  // the item id is set only when something actually moved.
  const moved = item ? 1 : 0;
  const takes = () => a.logMatches(/\[mp\] loot: take/);
  ctx.log(`loot: ${res} item=${item}`);
  for (const l of a.logMatches(/\[mp\] (loot|drop):/)) ctx.log('  ' + l.slice(0, 220));
  if (moved === 0) {
    // The canonical corpse carried nothing: then nothing may have been reported as taken.
    assert.deepEqual(takes(), [], 'an empty corpse produced a take report (shedding read as a take)');
    ctx.log('the canonical corpse was empty; no take was reported -- the false-take half holds');
    return;
  }
  await ctx.sleep(1500);
  const after = await count(item);
  await ctx.sleep(10_000);
  const later = await count(item);
  ctx.log(`${item}: just after ${after}, 10 s later ${later} (moved ${moved})`);
  assert.ok(after >= moved, `the looted ${item} is not in the pack (${after})`);
  assert.equal(later, after, 'and it is still there 10 s later');
  for (const l of takes()) assert.ok(l.includes(item), `a take was reported for something we did not move: ${l}`);
  assert.deepEqual(a.logMatches(/\[mp\] drop:/), [], 'nothing looted was reported as dropped');
  assert.deepEqual(a.luaErrors(), [], 'no Lua error');
}
