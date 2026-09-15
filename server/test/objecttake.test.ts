// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Picking up a world item is a REQUEST the server answers, not an announcement it accepts.
// The race is the point: two players activate the same item, exactly one may keep it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { CellStore } from '../src/persist/cellstore';
import { TestClient, tmpDataDir } from './helpers';

test('two players take the same item: one wins, the other is told gone', async (t) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const join = async (name: string) => {
    const c = await TestClient.connect(server.port);
    t.after(() => c.close());
    await c.joinAsNew(name);
    await c.waitEvent('PlayerList');
    c.sendCellChange('0,0', 0, 0, 0);
    await c.waitEvent('WorldCellState');
    return c;
  };
  const a = await join('Alice');
  const b = await join('Bob');

  a.sendEvent('ObjectSpawnRequest', { tempId: 1, recordId: 'gold_001', cellKey: '0,0', x: 0, y: 0, z: 0, rotZ: 0, count: 1 });
  const ack = await a.waitEvent('ObjectSpawnAck');
  const netId = (ack.value as { netId: number }).netId;
  await b.waitEvent('ObjectPlace'); // Bob can see it before he reaches for it

  // Both reach for it in the same instant.
  a.sendEvent('ObjectTakeRequest', { opId: 11, net: netId, cellKey: '0,0' });
  b.sendEvent('ObjectTakeRequest', { opId: 22, net: netId, cellKey: '0,0' });
  const ra = (await a.waitEvent('ObjectTakeResult')).value as { opId: number; ok: boolean; reason?: string };
  const rb = (await b.waitEvent('ObjectTakeResult')).value as { opId: number; ok: boolean; reason?: string };
  assert.equal(ra.opId, 11);
  assert.equal(rb.opId, 22);
  const winners = [ra, rb].filter((r) => r.ok);
  const losers = [ra, rb].filter((r) => !r.ok);
  assert.equal(winners.length, 1, `exactly one may keep it, got ${JSON.stringify([ra, rb])}`);
  assert.equal(losers.length, 1);
  assert.equal(losers[0]!.reason, 'gone', 'the loser must be told the item is gone, not left waiting');

  // Everyone is told it left the world -- the loser's client removes it from view on this.
  // The relay names a net object by `net`, the same key the client's addrOf puts on the wire.
  const gone = (await b.waitEvent('ObjectDelete')).value as { net: number };
  assert.equal(gone.net, netId);

  // Asking again for a tombstone is 'gone', never a second win.
  a.sendEvent('ObjectTakeRequest', { opId: 33, net: netId, cellKey: '0,0' });
  const again = (await a.waitEvent('ObjectTakeResult', (v) => (v as { opId: number }).opId === 33)).value as { ok: boolean; reason?: string };
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'gone');
});

test('a take from out of reach is refused, not dropped on the floor', async (t) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const far = await TestClient.connect(server.port);
  t.after(() => far.close());
  await far.joinAsNew('Far');
  await far.waitEvent('PlayerList');
  far.sendCellChange('9,9', 0, 0, 0);
  await far.waitEvent('WorldCellState');
  // A client that suppressed its own pickup is WAITING: silence here would hang it.
  far.sendEvent('ObjectTakeRequest', { opId: 5, ref: { __refnum: { index: 900, contentFile: 0 } }, cellKey: '0,0' });
  const r = (await far.waitEvent('ObjectTakeResult')).value as { ok: boolean; reason?: string };
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unreachable');
});

// Backlog 318. Tombstones are the persistence of a content-ref take; at the cap the take used
// to reply ok and persist nothing, so the item came back on every reload -- a dupe. Now it
// is refused (cell_full) and nothing is relayed. A net ref never needs one: gone from
// `placed` is gone.
test('a take in a cell whose tombstones are full is refused; a net ref never tombstones', async (t) => {
  const dataDir = tmpDataDir();
  const seed = new CellStore(dataDir);
  const doc = await seed.get('0,0');
  for (let i = 0; i < 2000; i++) doc.deleted.push(`c:${i}:0`); // MAX_DELETED_PER_CELL
  seed.markDirty('0,0');
  await seed.close();

  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const join = async (name: string) => {
    const c = await TestClient.connect(server.port);
    t.after(() => c.close());
    await c.joinAsNew(name);
    await c.waitEvent('PlayerList');
    c.sendCellChange('0,0', 0, 0, 0);
    await c.waitEvent('WorldCellState');
    return c;
  };
  const a = await join('Alice');
  const b = await join('Bob');

  a.sendEvent('ObjectTakeRequest', { opId: 1, ref: { __refnum: { index: 9999, contentFile: 0 } }, cellKey: '0,0' });
  const full = (await a.waitEvent('ObjectTakeResult')).value as { ok: boolean; reason?: string };
  assert.equal(full.ok, false);
  assert.equal(full.reason, 'cell_full', 'an ok that will not persist is a dupe on reload');

  // A net ref still works at the cap: placed is its truth, no tombstone is written.
  a.sendEvent('ObjectSpawnRequest', { tempId: 1, recordId: 'gold_001', cellKey: '0,0', x: 0, y: 0, z: 0, rotZ: 0, count: 1 });
  const netId = ((await a.waitEvent('ObjectSpawnAck')).value as { netId: number }).netId;
  await b.waitEvent('ObjectPlace');
  a.sendEvent('ObjectTakeRequest', { opId: 2, net: netId, cellKey: '0,0' });
  const ok = (await a.waitEvent('ObjectTakeResult', (v) => (v as { opId: number }).opId === 2)).value as { ok: boolean };
  assert.equal(ok.ok, true);
  // The FIRST delete Bob sees is the net take: the refused content take was not relayed.
  assert.equal(((await b.waitEvent('ObjectDelete')).value as { net?: number }).net, netId, 'the take is relayed');
  a.sendEvent('ObjectTakeRequest', { opId: 3, net: netId, cellKey: '0,0' });
  const again = (await a.waitEvent('ObjectTakeResult', (v) => (v as { opId: number }).opId === 3)).value as { ok: boolean; reason?: string };
  assert.equal(again.reason, 'gone');
  a.inbox.events.length = 0;
  a.sendEvent('ResyncRequest', { cellKey: '0,0' });
  const state = (await a.waitEvent('WorldCellState')).value as { placed: unknown[]; deleted: string[] };
  assert.equal(state.deleted.length, 2000, 'no tombstone for the net ref');
  assert.deepEqual(state.placed, []);
});
