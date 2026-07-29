// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 3.7 cell lifecycle: a reset RESTOCKS containers to their first-seen roll (rather
// than forgetting them) and hands the restored truth to players standing in the cell as
// CellSnapshotReplace — the primitive TES3MP lacks, whose absence forces its admins to
// kick everyone (and produces the #698 crash loop). Plus: a journal advance is on disk
// before the next tick, so a mid-quest disconnect cannot lose it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CellStore } from '../src/persist/cellstore';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir, readPlayerDoc } from './helpers';

const REF = { __refnum: { index: 42, contentFile: 0 } };

test('resetCell restocks containers to their first-seen contents, climbing stateSeq', async () => {
  const dir = tmpDataDir();
  const cells = new CellStore(dir);
  const doc = await cells.get('Balmora, Bar');
  doc.containers['c:42:0'] = {
    items: [{ id: 'gold_001', n: 3 }], // looted down to 3
    stateSeq: 7,
    origin: [{ id: 'gold_001', n: 100 }, { id: 'potion_cure', n: 2 }],
  };
  cells.markDirty('Balmora, Bar');

  const restored = await cells.resetCell('Balmora, Bar');
  const cont = restored.containers['c:42:0'];
  assert.ok(cont, 'the container survives the reset');
  assert.deepEqual(cont.items, [{ id: 'gold_001', n: 100 }, { id: 'potion_cure', n: 2 }],
    'restocked to the original roll — this is merchant gold coming back');
  assert.ok(cont.stateSeq > 7, 'stateSeq must climb so no client rejects the restock as stale');
  assert.ok(cont.origin, 'origin survives so the NEXT reset can restock too');
  await cells.close();
});

test('a reset hands standing players the restored truth instead of kicking them', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({
    dataDir, port: 0, host: '127.0.0.1',
    configOverride: { cellReset: { cells: ['0,0'], intervalSec: 0 } }, // registered, manual only
  });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Alice');
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);

  // Establish a container, then loot it empty.
  a.sendEvent('ContainerOpen', { ref: REF, cellKey: '0,0', contents: [{ id: 'gold_001', n: 100 }] });
  await a.waitEvent('ContainerState');
  a.sendEvent('ContainerOpRequest', { ref: REF, cellKey: '0,0', opId: 1, op: 'take', itemId: 'gold_001', n: 100 });
  const looted = await a.waitEvent('ContainerOpResult');
  assert.equal((looted.value as { ok: boolean }).ok, true);

  // Reset while Alice is STILL STANDING THERE — the case TES3MP cannot handle.
  await server.api.world.resetCell('0,0');

  const snap = await a.waitEvent('CellSnapshotReplace');
  const body = snap.value as { cellKey: string; containers: Record<string, { items: { id: string; n: number }[] }> };
  assert.equal(body.cellKey, '0,0');
  assert.deepEqual(body.containers['c:42:0']?.items, [{ id: 'gold_001', n: 100 }],
    'the player in the room is handed the restocked chest, not a kick');
  assert.ok(!a.isClosed, 'and is still connected: a reset must never require kicking occupants');
  a.close();
});

test('a journal advance is durable immediately, not on the 45s sweep', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  const { welcome } = await a.joinAsNew('Alice');
  const charId = welcome['characterId'] as string;
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);

  a.sendEvent('JournalEntry', { questId: 'A1_1_FindSpymaster', index: 10 });
  await new Promise((r) => setTimeout(r, 400)); // no flush(), no sweep, still connected

  const doc = readPlayerDoc(dataDir, charId) as
    { journal?: Record<string, number> };
  assert.equal(doc.journal?.A1_1_FindSpymaster, 10,
    'a quest stage must hit the disk at once — the Tribunal-MQ corruption is a crash before the sweep');
  a.close();
});
