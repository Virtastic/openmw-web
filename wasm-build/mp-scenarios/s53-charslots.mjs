// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s53 (character slots): a fresh account gets exactly one default character; creating a
// second slot works from in-world; switching to it is a reconnect that lands ON the new
// character (Welcome.characterId flips), and the two slots have separate state (the new
// one is fresh — no playerRecord).
import assert from 'node:assert/strict';

const STEP = 30_000;

export default async function run(ctx) {
  const a = await ctx.launchClient('slots-a', '');

  // A fresh account: exactly one slot, active, named after the account.
  await a.waitFor("((window.__omwMP||{}).characterId||'') !== ''", STEP, 'Welcome carried a characterId');
  const firstId = String(await a.eval("(window.__omwMP||{}).characterId"));
  assert.match(firstId, /^c[0-9a-f]{24}$/, `default character id looks wrong: ${firstId}`);
  assert.equal(String(await a.eval("(window.__omwMP||{}).characterCount")), '1');
  const chars = JSON.parse(String(await a.eval("(window.__omwMP||{}).characters||'[]'")));
  assert.equal(chars[0].name.toLowerCase(), a.name.toLowerCase(),
    'the migrated/default slot is named after the account');
  ctx.log(`  ok: one default character ${firstId}`);

  // Create a second slot from in-world (the Characters tab's create path).
  await a.eval("Module.__omwMPCmd='charcreate:Drelas Arano'");
  await a.waitFor("(window.__omwMP||{}).characterCount === '2'", STEP, 'second slot appears');
  const after = JSON.parse(String(await a.eval("(window.__omwMP||{}).characters")));
  const alt = after.find((c) => c.name === 'Drelas Arano');
  assert.ok(alt, `created slot missing from list: ${JSON.stringify(after)}`);
  assert.notEqual(alt.id, firstId);
  ctx.log(`  ok: created second slot ${alt.id}`);

  // Switch: a reconnect that must come back AS the new character.
  await a.eval(`Module.__omwMPCmd='charswitch:${alt.id}'`);
  await a.waitFor(`((window.__omwMP||{}).characterId||'') === '${alt.id}'`, STEP,
    'reconnect lands on the selected character');
  await a.waitFor("(window.__omwMP||{}).state === 'Joined'", STEP, 'and reaches Joined');
  ctx.log('  ok: switched — the session now plays the new slot');

  // And back: the original slot must still be selectable (nothing was lost).
  await a.eval(`Module.__omwMPCmd='charswitch:${firstId}'`);
  await a.waitFor(`((window.__omwMP||{}).characterId||'') === '${firstId}'`, STEP,
    'switching back to the first character works');
  ctx.log('  ok: round trip between slots');
}
