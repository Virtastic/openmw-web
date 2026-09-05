// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Picking up a world item is a REQUEST the server answers, not an announcement it accepts.
// The race is the point: two players activate the same item, exactly one may keep it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
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
