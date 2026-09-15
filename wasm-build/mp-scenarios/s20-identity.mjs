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
  const idA = await a.eval('window.omw.state.playerId');
  const puppetOnB = `JSON.parse(window.omw.state.puppets||"{}")[${JSON.stringify(idA)}]`;
  await b.waitFor(`!!${puppetOnB}`, SPAWN_TIMEOUT, 'puppet of A on B');

  // Appearance: the puppet's rebuilt record must be NAMED after A (PlayerAppearance relay).
  await b.waitFor(`(${puppetOnB}||{}).name === ${JSON.stringify(a.name)}`,
    EQUIP_TIMEOUT, `puppet named ${a.name} on B`);
  ctx.log('ok: puppet record carries A\'s name');

  // Equipment: A equips a helmet (the demo ships no item records, so 'equiptest' creates a
  // dynamic one — B therefore equips its local placeholder in the same SLOT, which is the
  // sync being asserted; with shared retail content the exact record id carries over).
  await a.eval(`window.omw.send('equiptest')`);
  await a.waitFor('(window.omw.state.equippedIds||"") !== ""',
    EQUIP_TIMEOUT, 'A equips the test helmet');
  const t0 = Date.now();
  await b.waitFor(`((${puppetOnB}||{}).eq||[]).length > 0`,
    EQUIP_TIMEOUT, 'puppet of A has the helmet slot equipped on B');
  ctx.log(`ok: equipment propagated to the puppet in ${Date.now() - t0}ms`);

  // Dynamic stats ON THE WIRE: B's puppet of A must fall when A's health hits zero. The old
  // step read A's own hp mirror back on A, which proved nothing about B (backlog 246); the
  // puppets mirror carries `dead`, so death is the one dynamic-stat edge B can be asked about
  // without a Lua change. (A respawns; s22 owns the respawn itself.)
  await a.eval(`window.omw.send('sethp:0')`);
  await b.waitFor(`(${puppetOnB}||{}).dead === true`, EQUIP_TIMEOUT, "B's puppet of A is dead (PlayerStatsDynamic reached B)");
  ctx.log('ok: dynamic stats reached B\'s puppet (it fell)');
  await b.waitFor(`(${puppetOnB}||{}).dead === false`, 30_000, "B's puppet of A is up again after the respawn");
  ctx.log('ok: the revive reached B too');
}
