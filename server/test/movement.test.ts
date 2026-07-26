// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M1 movement: codec golden vectors, quantization bounds, visibility matrix, and the
// live relay pipeline (stale-drop, batches, cell bubbles, budget) over real ws clients.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  packMove,
  unpackMove,
  packMoveBatch,
  unpackMoveBatch,
  quantYaw,
  unquantYaw,
  quantPitch,
  unquantPitch,
  quantAnimVel,
  unquantAnimVel,
  type PlayerPose,
} from '../src/proto/movement';
import { cellsVisible, MoveBroadcaster } from '../src/core/movement';
import { ProtoError } from '../src/proto/envelope';
import { startServer } from '../src/server';
import type { Roster } from '../src/core/players';
import { TestClient, tmpDataDir } from './helpers';

const POSE: PlayerPose = { x: 1.5, y: -2, z: 3, yaw: 0x1234, pitch: 0x40, flags: 0b010101, animVel: 200, counter: 0 };

test('movement codec golden vectors', () => {
  // Hand-computed: f32 LE 1.5 = 00 00 C0 3F, -2 = 00 00 00 C0, 3 = 00 00 40 40,
  // yaw 0x1234 LE = 34 12, pitch 40, flags 15, animVel C8, counter 00, 2 reserved zero
  // bytes pad the field list (18 B) to the specced 20-byte payload.
  const expected = Buffer.from([
    0x00, 0x00, 0xc0, 0x3f,
    0x00, 0x00, 0x00, 0xc0,
    0x00, 0x00, 0x40, 0x40,
    0x34, 0x12,
    0x40, 0x15, 0xc8, 0x00,
    0x00, 0x00,
  ]);
  assert.deepEqual([...packMove(POSE)], [...expected]);
  assert.deepEqual(unpackMove(expected), POSE);

  const batch = packMoveBatch([{ id: 0xbeef, pose: POSE }]);
  assert.deepEqual([...batch.subarray(0, 3)], [0x01, 0xef, 0xbe]); // count, id LE
  assert.deepEqual([...batch.subarray(3)], [...expected]);
  assert.deepEqual(unpackMoveBatch(batch), [{ id: 0xbeef, pose: POSE }]);
  assert.deepEqual(unpackMoveBatch(Buffer.from([0x00])), []);

  assert.throws(() => unpackMove(Buffer.alloc(19)), ProtoError);
  assert.throws(() => unpackMove(Buffer.alloc(21)), ProtoError);
  assert.throws(() => unpackMoveBatch(Buffer.from([0x02, 0x01, 0x00])), ProtoError); // count lies
  assert.throws(() => unpackMoveBatch(Buffer.alloc(0)), ProtoError);
});

test('quantization round-trips within step bounds and clamps', () => {
  const TWO_PI = Math.PI * 2;
  for (const yaw of [0, 0.001, 1, Math.PI, TWO_PI - 0.001, TWO_PI, 7.5, -1]) {
    const norm = ((yaw % TWO_PI) + TWO_PI) % TWO_PI;
    const back = unquantYaw(quantYaw(yaw));
    const diff = Math.min(Math.abs(back - norm), TWO_PI - Math.abs(back - norm)); // wrap-aware
    assert.ok(diff <= TWO_PI / 65536, `yaw ${yaw}: diff ${diff}`);
  }
  assert.equal(quantYaw(TWO_PI), 0); // wraps, not clamps
  assert.equal(quantYaw(Math.PI), 32768);

  for (const pitch of [-Math.PI / 2, -0.5, 0, 0.5, Math.PI / 2]) {
    assert.ok(Math.abs(unquantPitch(quantPitch(pitch)) - pitch) <= Math.PI / 255);
  }
  assert.equal(quantPitch(10), 255); // clamped high
  assert.equal(quantPitch(-10), 0); // clamped low

  assert.equal(quantAnimVel(-1), 0);
  assert.equal(quantAnimVel(5), 255); // clamped at 2x
  assert.equal(quantAnimVel(2), 255);
  for (const v of [0, 0.33, 1, 1.99, 2]) {
    assert.ok(Math.abs(unquantAnimVel(quantAnimVel(v)) - v) <= 2 / 255);
  }
});

test('visibility matrix', () => {
  // Interiors: exact same key only.
  assert.equal(cellsVisible('balmora, south wall cornerclub', 'balmora, south wall cornerclub'), true);
  assert.equal(cellsVisible('balmora, south wall cornerclub', 'balmora, eight plates'), false);
  // Exterior adjacency (Chebyshev <= 1), including negatives.
  assert.equal(cellsVisible('0,0', '0,0'), true);
  assert.equal(cellsVisible('0,0', '1,1'), true);
  assert.equal(cellsVisible('-1,0', '0,0'), true);
  assert.equal(cellsVisible('-1,-1', '0,0'), true);
  assert.equal(cellsVisible('-2,0', '-1,1'), true);
  assert.equal(cellsVisible('0,0', '2,0'), false);
  assert.equal(cellsVisible('0,0', '0,-2'), false);
  assert.equal(cellsVisible('-3,9', '4,-2'), false);
  // Interior vs exterior never match.
  assert.equal(cellsVisible('0,0', 'some cave'), false);
  // Unknown cell -> visible to nobody.
  assert.equal(cellsVisible(undefined, '0,0'), false);
  assert.equal(cellsVisible('0,0', undefined), false);
  assert.equal(cellsVisible(undefined, undefined), false);
});

test('movement relay over real clients', async (t) => {
  const server = await startServer({ dataDir: tmpDataDir(), port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  const { playerId: aId } = await a.joinAsNew('Alice');
  await a.waitEvent('PlayerList');
  const b = await TestClient.connect(server.port);
  const { playerId: bId } = await b.joinAsNew('Bob');
  await b.waitEvent('PlayerList');

  await t.test('PlayerCellChange relays to everyone with id added', async () => {
    a.sendCellChange('3,-2', 100, 200, 300);
    const seenByB = await b.waitEvent('PlayerCellChange');
    assert.deepEqual(seenByB.value, { id: aId, cellKey: '3,-2', x: 100, y: 200, z: 300 });
    const seenByA = await a.waitEvent('PlayerCellChange'); // relay includes the sender
    assert.deepEqual(seenByA.value, { id: aId, cellKey: '3,-2', x: 100, y: 200, z: 300 });
  });

  await t.test('adjacent-cell pose reaches the peer within 200ms', async () => {
    b.sendCellChange('4,-2', 0, 0, 0); // Chebyshev 1 from a's "3,-2"
    await a.waitEvent('PlayerCellChange');
    await b.waitEvent('PlayerCellChange');
    // Mutual visibility just began: each side gets the other's synthesized pose
    // force-included. Drain both before timing the real move.
    await a.waitBatch((batch) => batch.entries.some((e) => e.id === bId));
    await b.waitBatch((batch) => batch.entries.some((e) => e.id === aId));

    const sent = Date.now();
    a.sendMove({ x: 123.5, y: -7, z: 42, yaw: 1000, pitch: 200, flags: 0b1, animVel: 90 });
    const batch = await b.waitBatch((x) => x.entries.some((e) => e.id === aId));
    assert.ok(Date.now() - sent <= 200, `batch took ${Date.now() - sent}ms`);
    const entry = batch.entries.find((e) => e.id === aId)!;
    assert.deepEqual(entry.pose, { x: 123.5, y: -7, z: 42, yaw: 1000, pitch: 200, flags: 1, animVel: 90, counter: 0 });
  });

  await t.test('stale seq is dropped', async () => {
    a.sendMove({ x: 999, y: 0, z: 0 }, 1); // seq far below a's current counter
    // The fresh move after it must be the next thing b sees from a — never x=999.
    a.sendMove({ x: 55, y: 0, z: 0 });
    const batch = await b.waitBatch((x) => x.entries.some((e) => e.id === aId));
    assert.equal(batch.entries.find((e) => e.id === aId)!.pose.x, 55);
    assert.ok(!b.inbox.batches.some((x) => x.entries.some((e) => e.id === aId && e.pose.x === 999)));
  });

  await t.test('far cell gets no batches; return force-includes latest pose', async () => {
    b.sendCellChange('20,20', 0, 0, 0);
    await b.waitEvent('PlayerCellChange');
    b.inbox.batches.length = 0;
    a.sendMove({ x: 777, y: 1, z: 1 });
    await new Promise((r) => setTimeout(r, 300)); // >4 ticks
    assert.equal(b.inbox.batches.filter((x) => x.entries.some((e) => e.id === aId)).length, 0);

    // Coming back adjacent force-includes a's current pose without a re-sending.
    b.sendCellChange('3,-1', 0, 0, 0);
    const batch = await b.waitBatch((x) => x.entries.some((e) => e.id === aId));
    assert.equal(batch.entries.find((e) => e.id === aId)!.pose.x, 777);
  });

  await t.test('/status exposes cellKey per player', async () => {
    const status = (await (await fetch(`http://127.0.0.1:${server.port}/status`)).json()) as {
      players: { id: number; cellKey: string | null }[];
    };
    assert.equal(status.players.find((p) => p.id === aId)?.cellKey, '3,-2');
    assert.equal(status.players.find((p) => p.id === bId)?.cellKey, '3,-1');
  });

  await t.test('out-of-bounds and non-finite moves are ignored', async () => {
    a.sendMove({ x: 600000, y: 0, z: 0 });
    a.sendMove({ x: Number.NaN, y: 0, z: 0 });
    a.sendMove({ x: 11, y: 0, z: 0 });
    const batch = await b.waitBatch((x) => x.entries.some((e) => e.id === aId));
    assert.equal(batch.entries.find((e) => e.id === aId)!.pose.x, 11);
  });

  a.close();
  b.close();
  await a.closed;
  await b.closed;
});

// Was a kick; movement now SHEDS (see backpressure.test.ts). Kicking a player for a burst
// of self-correcting absolute poses cost more than the frames it saved.
test('movement budget shed', async (t) => {
  const server = await startServer({
    dataDir: tmpDataDir(),
    port: 0,
    host: '127.0.0.1',
    configOverride: { limits: { moveMsgsPerSec: 5 } },
  });
  t.after(() => server.close());

  const c = await TestClient.connect(server.port);
  await c.joinAsNew('Speedy');
  await c.waitEvent('PlayerList');
  c.sendCellChange('0,0');
  await c.waitEvent('PlayerCellChange');
  // General msg budget (60/s) untouched; the move budget (5) trips on a flood — the excess
  // frames are dropped and the session lives.
  for (let i = 0; i < 40 && !c.isClosed; i++) c.sendMove({ x: i, y: 0, z: 0 });
  c.sendJson({ t: 'SessionPing', clientTime: 1 });
  await c.waitJson('SessionPong');
  assert.equal(c.isClosed, false);
  c.close();
  await c.closed;
});

test('broadcaster unit: no empty batches, per-recipient dirty tracking', () => {
  // Minimal fake roster/peers to observe exactly what each tick emits.
  const sent = new Map<number, Buffer[]>();
  const mkPlayer = (id: number, cellKey?: string) => ({
    id,
    name: `p${id}`,
    accountKey: `p${id}`,
    rank: 0,
    inWorld: true,
    cellKey,
    pose: { x: id, y: 0, z: 0, yaw: 0, pitch: 128, flags: 0, animVel: 0, counter: 0 },
    moveSeq: 0,
    poseVersion: 1,
    peer: {
      sendEvent: () => {},
      // Returns true = "delivered". The broadcaster only commits its per-recipient
      // seen-version map when the send actually lands, so a fake returning void would
      // silently model a permanently-shedding client.
      sendBinary: (_type: number, payload: Buffer) => {
        sent.get(id)?.push(payload) ?? sent.set(id, [payload]);
        return true;
      },
      disconnect: () => {},
    },
  });
  const p1 = mkPlayer(1, '0,0');
  const p2 = mkPlayer(2, '1,0');
  const roster = { inWorld: () => [p1, p2] };
  const bc = new MoveBroadcaster(roster as unknown as Roster, 1_000_000);

  bc.tick(); // both visible, both dirty -> one batch each
  assert.equal(sent.get(1)?.length, 1);
  assert.equal(sent.get(2)?.length, 1);
  assert.deepEqual(unpackMoveBatch(sent.get(1)![0]!).map((e) => e.id), [2]);

  bc.tick(); // nothing changed -> no frames at all
  assert.equal(sent.get(1)?.length, 1);
  assert.equal(sent.get(2)?.length, 1);

  p1.poseVersion++; // only p1 moved -> only p2 gets a batch
  bc.tick();
  assert.equal(sent.get(1)?.length, 1);
  assert.equal(sent.get(2)?.length, 2);
});
