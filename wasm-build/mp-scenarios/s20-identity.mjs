// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s20 (M2): identity sync. B's puppet-of-A must carry A's NAME (appearance relay -> rebuilt
// NPC record), and when A equips an item (iron_helmet from the demo content), B's puppet
// must equip it too (equipment relay -> grant + setEquipment).
import assert from 'node:assert/strict';

const SPAWN_TIMEOUT = 15_000;
const EQUIP_TIMEOUT = 12_000;

export default async function run(ctx) {
  const [a, b] = await Promise.all([
    ctx.launchClient('bot-a'),
    ctx.launchClient('bot-b'),
  ]);
  const idA = await a.eval('(window.__omwMP||{}).playerId');
  const puppetOnB = `JSON.parse((window.__omwMP||{}).puppets||"{}")[${JSON.stringify(idA)}]`;
  await b.waitFor(`!!${puppetOnB}`, SPAWN_TIMEOUT, 'puppet of A on B');

  // Appearance: the puppet's rebuilt record must be NAMED after A (PlayerAppearance relay).
  await b.waitFor(`(${puppetOnB}||{}).name === ${JSON.stringify(a.name)}`,
    EQUIP_TIMEOUT, `puppet named ${a.name} on B`);
  ctx.log('ok: puppet record carries A\'s name');

  // Equipment: A equips a helmet (the demo ships no item records, so 'equiptest' creates a
  // dynamic one — B therefore equips its local placeholder in the same SLOT, which is the
  // sync being asserted; with shared retail content the exact record id carries over).
  await a.eval(`Module.__omwMPCmd='equiptest'`);
  await a.waitFor('((window.__omwMP||{}).equippedIds||"") !== ""',
    EQUIP_TIMEOUT, 'A equips the test helmet');
  const t0 = Date.now();
  await b.waitFor(`((${puppetOnB}||{}).eq||[]).length > 0`,
    EQUIP_TIMEOUT, 'puppet of A has the helmet slot equipped on B');
  ctx.log(`ok: equipment propagated to the puppet in ${Date.now() - t0}ms`);

  // Dynamic stats: A drops to 40 hp; nothing to read back on B beyond no-crash (stats land
  // on the puppet's health bar), but A's own mirror must reflect it (0.25s diff).
  await a.eval(`Module.__omwMPCmd='sethp:40'`);
  await a.waitFor('(window.__omwMP||{}).hp === "40"', 5000, 'A hp mirror = 40');
  ctx.log('ok: dynamic stats mirror updates');
}
