// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 3/4 content rules: quest items never deplete from a container (so a second
// player can still complete the same quest), and in a resetting public world a unique
// NPC's corpse is stripped (an infinite-respawn world must not mint artifacts).

import test from 'node:test';
const PEER_PASS = 'peer-secret-1'; // the peer's credential; players cannot hold cells
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContentTable } from '../src/core/content-table';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

test('content table: defaults classify, a file overrides, a missing file is permissive', async () => {
  const defaults = ContentTable.defaults();
  assert.ok(defaults.isQuestItem('Dwemer Puzzle Box'), 'case-insensitive vanilla default');
  assert.ok(defaults.isUniqueActor('vivec_god'));
  assert.ok(defaults.isNotableItem('Sunder'));
  assert.ok(!defaults.isQuestItem('iron_dagger'));

  const dir = tmpDataDir();
  writeFileSync(join(dir, 'content-table.json'), JSON.stringify({ questItems: ['my_mod_macguffin'] }));
  const loaded = await ContentTable.load(dir);
  assert.ok(loaded.isQuestItem('my_mod_macguffin'), 'a declared list is used');
  assert.ok(!loaded.isQuestItem('Dwemer Puzzle Box'), 'and REPLACES the default for that list');
  assert.ok(loaded.isUniqueActor('vivec_god'), 'undeclared lists keep their defaults');

  // A malformed file must not take the world down — rules degrade permissive.
  const bad = tmpDataDir();
  writeFileSync(join(bad, 'content-table.json'), '{not json');
  const fallback = await ContentTable.load(bad);
  assert.ok(fallback.isQuestItem('Dwemer Puzzle Box'));
});

test('quest items never deplete: two players can each take the Puzzle Box', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Alice');
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  const b = await TestClient.connect(server.port);
  await b.joinAsNew('Bob');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);

  // Establish canonical container state holding one quest item and one ordinary item.
  a.sendEvent('ContainerOpen', {
    ref: { __refnum: { index: 77, contentFile: 0 } },
    cellKey: '0,0',
    contents: [{ id: 'dwemer puzzle box', n: 1 }, { id: 'iron_dagger', n: 1 }],
  });
  await new Promise((r) => setTimeout(r, 200));

  // Alice takes the quest item: accepted, and NO ContainerUpdate is relayed (nothing
  // changed for anyone else — that is the whole point).
  a.sendEvent('ContainerOpRequest', {
    ref: { __refnum: { index: 77, contentFile: 0 } }, cellKey: '0,0',
    opId: 1, op: 'take', itemId: 'dwemer puzzle box', n: 1,
  });
  const r1 = await a.waitEvent('ContainerOpResult');
  assert.equal((r1.value as { ok: boolean }).ok, true, 'the taker gets their copy');

  // Bob takes the SAME quest item afterwards: still there.
  b.sendEvent('ContainerOpRequest', {
    ref: { __refnum: { index: 77, contentFile: 0 } }, cellKey: '0,0',
    opId: 2, op: 'take', itemId: 'dwemer puzzle box', n: 1,
  });
  const r2 = await b.waitEvent('ContainerOpResult');
  assert.equal((r2.value as { ok: boolean }).ok, true,
    'a quest item must still be there for the next eligible player (the TES3MP break)');

  // An ORDINARY item still depletes: the rule is narrow, not "containers are infinite".
  a.sendEvent('ContainerOpRequest', {
    ref: { __refnum: { index: 77, contentFile: 0 } }, cellKey: '0,0',
    opId: 3, op: 'take', itemId: 'iron_dagger', n: 1,
  });
  assert.equal(((await a.waitEvent('ContainerOpResult')).value as { ok: boolean }).ok, true);
  b.sendEvent('ContainerOpRequest', {
    ref: { __refnum: { index: 77, contentFile: 0 } }, cellKey: '0,0',
    opId: 4, op: 'take', itemId: 'iron_dagger', n: 1,
  });
  const r4 = await b.waitEvent('ContainerOpResult');
  assert.equal((r4.value as { ok: boolean; reason?: string }).ok, false, 'ordinary loot is still finite');
  a.close();
  b.close();
});

test('public no-drop: a unique NPC corpse is stripped for the whole cell', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false,
    dataDir, port: 0, host: '127.0.0.1',
    worldMode: 'public',
    configOverride: { economy: { noDrop: true }, server: { password: PEER_PASS } },
  });
  t.after(() => server.close());

  // Actor events are holder-only and epoch-guarded, and only the sim peer can hold — so the
  // sender of those events is the peer, not a player.
  const a = await TestClient.simPeer(server.port, PEER_PASS, 'Alice');
  a.sendCellChange('0,0', 0, 0, 0);
  const grant = await a.waitEvent('ActorAuthorityGrant');
  const epoch = (grant.value as { epoch: number }).epoch;
  const b = await TestClient.connect(server.port);
  await b.joinAsNew('Bob');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);

  // A unique dies: everyone in the cell is told to strip the corpse.
  a.sendEvent('ActorDeath', {
    ref: { __refnum: { index: 5, contentFile: 0 } }, cellKey: '0,0', epoch,
    deathNo: 1, killedRecordId: 'vivec_god',
  });
  const strip = await b.waitEvent('ActorStripLoot');
  assert.equal((strip.value as { reason: string }).reason, 'unique');

  // An ordinary creature is untouched — the rule targets farmable uniques only.
  a.sendEvent('ActorDeath', {
    ref: { __refnum: { index: 6, contentFile: 0 } }, cellKey: '0,0', epoch,
    deathNo: 1, killedRecordId: 'rat',
  });
  await b.waitEvent('WorldKillCount', (v) => (v as { refId: string }).refId === 'rat');
  assert.equal(b.inbox.events.filter((e) => e.name === 'ActorStripLoot').length, 0,
    'ordinary creatures still drop their loot');
  a.close();
  b.close();
});
