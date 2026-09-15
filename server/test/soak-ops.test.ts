// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The soak bots' container / drop / pick messages VALIDATE (backlog 87): each one gets the
// ok it would get from a real client, so the soak measures the transactional paths rather
// than the invalid-message counter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';
import { containerCycle, dropOp, pickOp } from '../bots/soak-ops';

test('soak container cycle and drop/pick are accepted by the server', async (t) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const c = await TestClient.connect(server.port);
  t.after(() => c.close());
  await c.joinAsNew('soak0');
  await c.waitEvent('PlayerList');
  c.sendCellChange('0,0', 100, 200, 512);
  await c.waitEvent('WorldCellState');

  const tick = 105;
  for (const m of containerCycle(tick, '0,0')) c.sendEvent(m.name, m.body);
  const st = (await c.waitEvent('ContainerState')).value as { items: { id: string; n: number }[] };
  assert.equal(st.items.length, 2, 'the first open rolls the chest');
  for (const opId of [tick * 2, tick * 2 + 1]) {
    const r = (await c.waitEvent('ContainerOpResult', (v) => (v as { opId: number }).opId === opId)).value as { ok: boolean; reason?: string };
    assert.equal(r.ok, true, `op ${opId} must be accepted: ${JSON.stringify(r)}`);
  }

  const drop = dropOp(tick, '0,0', 100, 200, 512);
  c.sendEvent(drop.name, drop.body);
  const ack = (await c.waitEvent('ObjectSpawnAck')).value as { tempId: number; netId: number };
  assert.equal(ack.tempId, tick);
  const pick = pickOp(tick, '0,0', ack.netId);
  c.sendEvent(pick.name, pick.body);
  const took = (await c.waitEvent('ObjectTakeResult')).value as { opId: number; ok: boolean; reason?: string };
  assert.deepEqual({ opId: took.opId, ok: took.ok }, { opId: tick, ok: true }, JSON.stringify(took));
});
