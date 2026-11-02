// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-126: a merchant's STOCK restocks on the 24h rule, not just its purse -- but only the
// entries the record marks as restocking (negative count; the client reports them at first
// open), and only the shortfall, so nothing a player sold in or a unique is ever duplicated.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CellStore } from '../src/persist/cellstore';
import { restockStock } from '../src/core/worldstate';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

test('restockStock tops up only the shortfall and never trims a surplus', () => {
  const items = [{ id: 'Potion_Cure', n: 1 }, { id: 'arrow', n: 50 }, { id: 'creeper_unique', n: 0 }];
  const added = restockStock(items, [{ id: 'potion_cure', n: 5 }, { id: 'arrow', n: 20 }, { id: 'bread', n: 2 }]);
  assert.equal(added, 4 + 2);
  assert.deepEqual(items, [{ id: 'Potion_Cure', n: 5 }, { id: 'arrow', n: 50 }, { id: 'creeper_unique', n: 0 }, { id: 'bread', n: 2 }]);
  assert.equal(restockStock(items, [{ id: 'potion_cure', n: 5 }, { id: 'bread', n: 2 }]), 0, 'a second pass is a no-op');
});

const sorted = (items: { id: string; n: number }[]) => items.filter((i) => i.n > 0).map((i) => `${i.id}:${i.n}`).sort();

test('a merchant restocks its restocking entries after 24 game hours; uniques and sold-in items do not change', async (t) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { time: { scale: 0 }, limits: { maxConnsPerIp: 16 } } });
  t.after(() => server.close());
  const REF = { __refnum: { index: 95, contentFile: 0 } };
  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Trader');
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  a.sendEvent('ContainerOpen', {
    ref: REF, cellKey: '0,0', gold: 500,
    contents: [{ id: 'potion_cure', n: 3 }, { id: 'creeper_unique', n: 1 }, { id: 'arrow', n: 10 }, { id: 'dwemer puzzle box', n: 1 }],
    // the client's claim: an id it was not seen holding, and a quest item, must never restock
    restocking: ['potion_cure', 'arrow', 'daedric_crescent', 'dwemer puzzle box'],
  });
  await a.waitEvent('ContainerState');
  let op = 0;
  const send = async (o: string, itemId: string, n: number) => {
    const id = ++op;
    a.sendEvent('ContainerOpRequest', { ref: REF, cellKey: '0,0', opId: id, op: o, itemId, n });
    const r = (await a.waitEvent('ContainerOpResult', (v) => (v as { opId: number }).opId === id)).value as { ok: boolean };
    assert.equal(r.ok, true, `${o} ${itemId}`);
  };
  await send('take', 'potion_cure', 3); // bought out
  await send('take', 'creeper_unique', 1); // a one-off
  await send('put', 'arrow', 5); // sold in: 15, over the restock count
  await send('take', 'dwemer puzzle box', 1);
  await send('put', 'ash_yam', 1);

  server.api.world.advanceTime(24);
  const b = await TestClient.connect(server.port);
  await b.joinAsNew('Customer');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);
  b.sendEvent('ContainerOpen', { ref: REF, cellKey: '0,0', contents: [], gold: 500 });
  const state = (await b.waitEvent('ContainerState')).value as { gold?: number; items: { id: string; n: number }[] };
  assert.deepEqual(sorted(state.items), ['arrow:15', 'ash_yam:1', 'dwemer puzzle box:1', 'potion_cure:3'],
    'potions back to 3; the unique stays bought; the arrow surplus is not trimmed or doubled; the quest item never depleted');
  assert.equal(state.gold, 500);

  // A second visit inside the same 24h restocks nothing more.
  const c = await TestClient.connect(server.port);
  await c.joinAsNew('Second');
  await c.waitEvent('PlayerList');
  c.sendCellChange('0,0', 0, 0, 0);
  c.sendEvent('ContainerOpen', { ref: REF, cellKey: '0,0', contents: [], gold: 500 });
  const again = (await c.waitEvent('ContainerState')).value as { items: { id: string; n: number }[] };
  assert.deepEqual(sorted(again.items), sorted(state.items));
  a.close(); b.close(); c.close();
});

test('without a restocking list (old client) only the purse restocks', async (t) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { time: { scale: 0 }, limits: { maxConnsPerIp: 16 } } });
  t.after(() => server.close());
  const REF = { __refnum: { index: 96, contentFile: 0 } };
  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Trader');
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  a.sendEvent('ContainerOpen', { ref: REF, cellKey: '0,0', gold: 100, contents: [{ id: 'potion_cure', n: 2 }] });
  await a.waitEvent('ContainerState');
  a.sendEvent('ContainerOpRequest', { ref: REF, cellKey: '0,0', opId: 1, op: 'take', itemId: 'potion_cure', n: 2 });
  await a.waitEvent('ContainerOpResult');
  server.api.world.advanceTime(24);
  const b = await TestClient.connect(server.port);
  await b.joinAsNew('Customer');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);
  b.sendEvent('ContainerOpen', { ref: REF, cellKey: '0,0', contents: [], gold: 100 });
  const state = (await b.waitEvent('ContainerState')).value as { items: { id: string; n: number }[] };
  assert.deepEqual(sorted(state.items), []);
  a.close(); b.close();
});

test('a cell reset keeps the restock list and the deposits of a merchant', async () => {
  const cells = new CellStore(tmpDataDir());
  const doc = await cells.get('Balmora, Shop');
  doc.containers['c:7:0'] = {
    items: [{ id: 'potion_cure', n: 0 }, { id: 'ash_yam', n: 2 }], stateSeq: 3,
    origin: [{ id: 'potion_cure', n: 3 }], gold: 10, goldOrigin: 500, goldRestockAt: 100,
    restock: [{ id: 'potion_cure', n: 3 }],
  };
  cells.markDirty('Balmora, Shop');
  const cont = (await cells.resetCell('Balmora, Shop')).containers['c:7:0']!;
  assert.deepEqual(cont.items, [{ id: 'potion_cure', n: 3 }, { id: 'ash_yam', n: 2 }]);
  assert.deepEqual(cont.restock, [{ id: 'potion_cure', n: 3 }]);
  assert.equal(cont.gold, 500);
  await cells.close();

  const carry = new CellStore(tmpDataDir(), false);
  (await carry.get('x')).containers['c:1:0'] = { items: [], stateSeq: 1, restock: [{ id: 'arrow', n: 9 }] };
  carry.markDirty('x');
  assert.deepEqual((await carry.resetCell('x')).containers['c:1:0']!.restock, [{ id: 'arrow', n: 9 }]);
  await carry.close();
});
