// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Crowded-cell survival: the actor-authority holder sheds instead of being disconnected,
// the abuse budgets still disconnect, and a client that stops draining is shed then
// dropped WITHOUT touching its neighbours.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { Connection } from '../src/net/connection';
import { metrics, resetMetrics } from '../src/metrics';
import { TestClient, tmpDataDir } from './helpers';
import type { ActorEntry } from '../src/proto/movement';

const REF_ENTRY: ActorEntry = {
  ref: { index: 42, contentFile: 0 },
  pose: { x: 7.5, y: -3, z: 100, yaw: 0x2000, pitch: 0x30, flags: 0, animVel: 128, counter: 0 },
};

// Multi-client tests need the per-IP budgets out of the way: a starved limiter fails a
// later subtest for the wrong reason (see adversarial.test.ts).
const ROOMY = { maxConnsPerIp: 200, loginPerMinPerIp: 10_000 };

const counter = (budget: string): number => metrics.rateLimited.get({ budget }) ?? 0;

test('movement budgets shed; abuse budgets still disconnect', async (t) => {
  resetMetrics();
  const server = await startServer({
    dataDir: tmpDataDir(),
    port: 0,
    host: '127.0.0.1',
    // Tiny movement budgets so a handful of frames overruns them; msgsPerSec is left
    // generous so the join handshake is not what trips.
    configOverride: { limits: { ...ROOMY, actorMoveMsgsPerSec: 5, moveMsgsPerSec: 5 } },
  });
  t.after(() => server.close());

  await t.test('holder over the actor budget sheds and stays connected', async () => {
    const holder = await TestClient.connect(server.port);
    await holder.joinAsNew('shed_holder');
    await holder.waitEvent('PlayerList');
    const peer = await TestClient.connect(server.port);
    await peer.joinAsNew('shed_peer');
    await peer.waitEvent('PlayerList');

    holder.sendCellChange('90,90', 0, 0, 0);
    const grant = await holder.waitEvent('ActorAuthorityGrant');
    const epoch = (grant.value as { epoch: number }).epoch;
    peer.sendCellChange('90,90', 0, 0, 0);
    await peer.waitEvent('ActorAuthorityInfo');

    const before = counter('actor_shed');
    for (let i = 0; i < 60; i++) holder.sendActorMoveBatch(epoch, [REF_ENTRY]);
    // The first batches are under budget and must still relay; the rest are shed.
    await peer.waitActorBatch();
    assert.ok(counter('actor_shed') > before, 'actor overrun did not register as a shed');

    // The mechanism under test: the session survives, so the cell keeps its authority.
    assert.equal(holder.isClosed, false);
    holder.sendJson({ t: 'SessionPing', clientTime: 1 });
    await holder.waitJson('SessionPong');
    assert.equal(counter('move_shed'), 0); // the two budgets are separate: actor traffic spent no own-pose tokens
    assert.equal(metrics.disconnects.get({ code: 'RATE' }) ?? 0, 0);

    holder.close();
    peer.close();
    await Promise.all([holder.closed, peer.closed]);
  });

  await t.test('own-pose overrun sheds too', async () => {
    const c = await TestClient.connect(server.port);
    await c.joinAsNew('shed_mover');
    await c.waitEvent('PlayerList');
    c.sendCellChange('91,91', 0, 0, 0);
    await c.waitEvent('PlayerCellChange');

    const before = counter('move_shed');
    for (let i = 0; i < 60; i++) c.sendMove({ x: i });
    c.sendJson({ t: 'SessionPing', clientTime: 2 });
    await c.waitJson('SessionPong');
    assert.ok(counter('move_shed') > before, 'own-pose overrun did not register as a shed');
    assert.equal(c.isClosed, false);
    assert.equal(metrics.disconnects.get({ code: 'RATE' }) ?? 0, 0);

    c.close();
    await c.closed;
  });
});

test('the message budget still disconnects', async (t) => {
  const server = await startServer({
    dataDir: tmpDataDir(),
    port: 0,
    host: '127.0.0.1',
    configOverride: { limits: { ...ROOMY, msgsPerSec: 10 } },
  });
  t.after(() => server.close());

  const c = await TestClient.connect(server.port);
  await c.joinAsNew('msg_flooder');
  await c.waitEvent('PlayerList');
  for (let i = 0; i < 50 && !c.isClosed; i++) c.sendEvent('ChatSend', { text: `spam ${i}` });
  const msg = await c.waitDisconnect('RATE');
  assert.match(String(msg['detail']), /message rate limit/);
  await c.closed;
});

test('the byte budget still disconnects, even on a movement frame', async (t) => {
  const server = await startServer({
    dataDir: tmpDataDir(),
    port: 0,
    host: '127.0.0.1',
    // Bytes are checked before the frame type is dispatched, so an oversized PlayerMove
    // burst is still an abuse signal and must not be shed into silence.
    configOverride: { limits: { ...ROOMY, bytesPerSec: 4096, moveMsgsPerSec: 10_000 } },
  });
  t.after(() => server.close());

  const c = await TestClient.connect(server.port);
  await c.joinAsNew('byte_flooder');
  await c.waitEvent('PlayerList');
  for (let i = 0; i < 400 && !c.isClosed; i++) c.sendMove({ x: i });
  const msg = await c.waitDisconnect('RATE');
  assert.match(String(msg['detail']), /byte rate limit/);
  await c.closed;
});

test('a stalled reader is shed, then dropped, without touching its neighbours', async (t) => {
  resetMetrics();
  const server = await startServer({
    dataDir: tmpDataDir(),
    port: 0,
    host: '127.0.0.1',
    configOverride: { limits: { ...ROOMY, maxBufferedBytes: 262_144, maxBufferedBytesHard: 1_048_576 } },
  });
  t.after(() => server.close());

  // A real socket drains as fast as we can write to it, so the backlog is injected through
  // the seam instead — and only for the one session named here, which is what makes the
  // "healthy peer is unaffected" assertion mean anything.
  let stalledBytes = 0;
  Connection.bufferedAmountReader = (conn) => (conn.player?.name === 'stalled_bob' ? stalledBytes : undefined);
  t.after(() => {
    Connection.bufferedAmountReader = undefined;
  });

  const alice = await TestClient.connect(server.port);
  await alice.joinAsNew('stalled_alice');
  await alice.waitEvent('PlayerList');
  const bob = await TestClient.connect(server.port);
  await bob.joinAsNew('stalled_bob');
  await bob.waitEvent('PlayerList');
  const carol = await TestClient.connect(server.port);
  await carol.joinAsNew('stalled_carol');
  await carol.waitEvent('PlayerList');

  alice.sendCellChange('92,92', 0, 0, 0);
  const grant = await alice.waitEvent('ActorAuthorityGrant');
  const epoch = (grant.value as { epoch: number }).epoch;
  for (const c of [bob, carol]) {
    c.sendCellChange('92,92', 0, 0, 0);
    await c.waitEvent('ActorAuthorityInfo');
  }

  await t.test('all three see actor traffic while everyone is draining', async () => {
    alice.sendActorMoveBatch(epoch, [REF_ENTRY]);
    await bob.waitActorBatch();
    await carol.waitActorBatch();
  });

  await t.test('over the soft limit only the stalled session loses movement', async () => {
    stalledBytes = 262_145;
    const before = metrics.backpressureDropped.get({ kind: 'actor' }) ?? 0;
    for (let i = 0; i < 5; i++) alice.sendActorMoveBatch(epoch, [{ ...REF_ENTRY, pose: { ...REF_ENTRY.pose, x: i } }]);
    // Carol is the fence: once she has the last batch, bob's would have been sent too.
    await carol.waitActorBatch((b) => b.batch.entries[0]!.pose.x === 4);
    assert.ok((metrics.backpressureDropped.get({ kind: 'actor' }) ?? 0) > before, 'no backpressure drop counted');
    assert.equal(bob.inbox.actorBatches.length, 0, 'stalled session was still fed actor batches');
    assert.equal(bob.isClosed, false, 'a soft-limit overrun must not close the session');
  });

  await t.test('past the hard ceiling the stalled session is disconnected, the peers are not', async () => {
    stalledBytes = 1_048_577;
    alice.sendActorMoveBatch(epoch, [{ ...REF_ENTRY, pose: { ...REF_ENTRY.pose, x: 99 } }]);
    const msg = await bob.waitDisconnect('RATE');
    assert.match(String(msg['detail']), /outbound buffer/);
    await bob.closed;

    // The point of the whole exercise: the cell keeps running for everyone else.
    assert.equal(alice.isClosed, false);
    assert.equal(carol.isClosed, false);
    alice.sendActorMoveBatch(epoch, [{ ...REF_ENTRY, pose: { ...REF_ENTRY.pose, x: 111 } }]);
    const got = await carol.waitActorBatch((b) => b.batch.entries[0]!.pose.x === 111);
    assert.equal(got.batch.epoch, epoch);
  });

  await t.test('buffered bytes are exposed as a gauge', () => {
    stalledBytes = 0;
    const text = metrics.outboundBuffered.toText();
    assert.match(text, /# TYPE omwmp_outbound_buffered_bytes gauge/);
    assert.match(text, /^omwmp_outbound_buffered_bytes \d+$/m);
  });

  alice.close();
  carol.close();
  await Promise.all([alice.closed, carol.closed]);
});
