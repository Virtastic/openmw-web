// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-179: a personal stash -- two players open the same chest and each sees only their own
// items; the content's own roll never appears; contents survive a restart and a cell reset.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CellStore } from '../src/persist/cellstore';
import { startServer, type RunningServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const REF = { __refnum: { index: 4242, contentFile: 0 } };
type Items = { id: string; n: number }[];

async function enter(c: TestClient): Promise<void> {
  await c.waitEvent('PlayerList');
  c.sendCellChange('0,0', 0, 0, 0);
  await c.waitEvent('WorldCellState', (v) => (v as { cellKey: string }).cellKey === '0,0');
}

async function open(c: TestClient): Promise<Items> {
  c.inbox.events.length = 0;
  c.sendEvent('ContainerOpen', { ref: REF, cellKey: '0,0', contents: [{ id: 'ebony_shield', n: 1 }] });
  return ((await c.waitEvent('ContainerState')).value as { items: Items }).items;
}

async function put(c: TestClient, opId: number, itemId: string, n: number): Promise<void> {
  c.sendEvent('ContainerOpRequest', { ref: REF, cellKey: '0,0', opId, op: 'put', itemId, n });
  assert.equal(((await c.waitEvent('ContainerOpResult')).value as { ok: boolean }).ok, true);
}

test('personal stash: each character sees only their own, across a restart', async () => {
  const dataDir = tmpDataDir();
  writeFileSync(join(dataDir, 'content-table.json'), JSON.stringify({ stashes: ['0,0|C:4242:0'] }));
  let server: RunningServer = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  try {
    const a = await TestClient.connect(server.port);
    await a.joinAsNew('Alice');
    await enter(a);
    const b = await TestClient.connect(server.port);
    await b.joinAsNew('Bob');
    await enter(b);

    assert.deepEqual(await open(a), [], "a stash ignores the opener's declared roll");
    await put(a, 1, 'iron_dagger', 1);
    assert.deepEqual(await open(b), [], "Bob does not see Alice's dagger");
    await put(b, 1, 'ash_yam', 3);
    assert.deepEqual(await open(a), [{ id: 'iron_dagger', n: 1 }]);
    assert.deepEqual(await open(b), [{ id: 'ash_yam', n: 3 }]);

    a.close();
    b.close();
    await a.closed;
    await b.closed;
    await server.close();
    server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
    const a2 = await TestClient.connect(server.port);
    await a2.joinExisting('Alice');
    await enter(a2);
    assert.deepEqual(await open(a2), [{ id: 'iron_dagger', n: 1 }], 'the stash survived the restart');
    a2.close();
    await a2.closed;
  } finally {
    await server.close();
  }

  // A restocking reset refills loot; it must not empty anyone's stash.
  const store = new CellStore(dataDir, true);
  const doc = await store.resetCell('0,0');
  const views = Object.values(doc.containers['c:4242:0']?.views ?? {}).map((v) => v.items);
  await store.close();
  assert.deepEqual(views.sort((x, y) => x[0]!.id.localeCompare(y[0]!.id)), [[{ id: 'ash_yam', n: 3 }], [{ id: 'iron_dagger', n: 1 }]]);
});
