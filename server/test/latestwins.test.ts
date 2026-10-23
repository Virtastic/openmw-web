// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Latest-state-wins outbound (connection.ts sendBinaryFrame): a client that is behind holds at
// most one pending frame per lossy stream, folded by entity, and gets it once it drains.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { Connection, mergeLossy } from '../src/net/connection';
import { packEnvelope, unpackEnvelope, MSG_ACTOR_MOVE_BATCH, MSG_PLAYER_MOVE_BATCH } from '../src/proto/envelope';
import { packActorMoveBatch, unpackActorMoveBatch, packMoveBatch, unpackMoveBatch, type ActorEntry, type PlayerPose } from '../src/proto/movement';
import { TestClient, tmpDataDir } from './helpers';

const PEER_PASS = 'peer-secret-lw';
const pose = (x: number): PlayerPose => ({ x, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0, animVel: 0, counter: 0 });
const actor = (index: number, x: number): ActorEntry => ({ ref: { index, contentFile: 0 }, pose: pose(x) });

test('mergeLossy keeps every entity, newest pose wins, newer envelope', () => {
  const older = packEnvelope(MSG_ACTOR_MOVE_BATCH, 10, packActorMoveBatch(7, [actor(1, 1), actor(2, 2)]));
  const newer = packEnvelope(MSG_ACTOR_MOVE_BATCH, 12, packActorMoveBatch(7, [actor(2, 20), actor(3, 30)]));
  const env = unpackEnvelope(mergeLossy(older, newer));
  assert.equal(env.seq, 12);
  const b = unpackActorMoveBatch(env.payload);
  assert.equal(b.epoch, 7);
  const byIndex = new Map(b.entries.map((e) => [e.ref.index, e.pose.x]));
  assert.deepEqual([...byIndex].sort(), [[1, 1], [2, 20], [3, 30]]);

  const pOld = packEnvelope(MSG_PLAYER_MOVE_BATCH, 1, packMoveBatch([{ id: 5, pose: pose(5) }]));
  const pNew = packEnvelope(MSG_PLAYER_MOVE_BATCH, 2, packMoveBatch([{ id: 6, pose: pose(6) }]));
  const ids = unpackMoveBatch(unpackEnvelope(mergeLossy(pOld, pNew)).payload).map((e) => e.id).sort();
  assert.deepEqual(ids, [5, 6]);
  // Nothing to add: the newer frame itself, not a copy.
  assert.equal(mergeLossy(pNew, pNew), pNew);
});

test('a stalled reader gets one merged frame per stream once it drains', async (t) => {
  const server = await startServer({ requireGameData: false,
    dataDir: tmpDataDir(),
    port: 0,
    host: '127.0.0.1',
    configOverride: { limits: { maxConnsPerIp: 200, loginPerMinPerIp: 10_000 }, server: { password: PEER_PASS } },
  });
  t.after(() => server.close());
  let stalled = 0;
  Connection.bufferedAmountReader = (conn) => (conn.player?.name === 'lw_bob' ? stalled : undefined);
  t.after(() => { Connection.bufferedAmountReader = undefined; });

  const peer = await TestClient.simPeer(server.port, PEER_PASS, 'lw_peer');
  const bob = await TestClient.connect(server.port);
  await bob.joinAsNew('lw_bob');
  await bob.waitEvent('PlayerList');
  peer.sendCellChange('93,93', 0, 0, 0);
  const epoch = ((await peer.waitEvent('ActorAuthorityGrant')).value as { epoch: number }).epoch;
  bob.sendCellChange('93,93', 0, 0, 0);
  await bob.waitEvent('ActorAuthorityInfo');

  stalled = 300_000; // over the soft limit: nothing lossy goes out
  // A cell chunked into two batches, each sent twice: the second chunk must not erase the first.
  peer.sendActorMoveBatch(epoch, [actor(1, 1), actor(2, 1)]);
  peer.sendActorMoveBatch(epoch, [actor(3, 1)]);
  peer.sendActorMoveBatch(epoch, [actor(1, 2), actor(2, 2)]);
  peer.sendActorMoveBatch(epoch, [actor(3, 2)]);
  // Reliable traffic is not held behind the lossy streams.
  peer.sendJson({ t: 'SessionPing', clientTime: 1 });
  await peer.waitJson('SessionPong');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(bob.inbox.actorBatches.length, 0, 'lossy frames went out over the soft limit');

  stalled = 0;
  const got = await bob.waitActorBatch();
  const xs = new Map(got.batch.entries.map((e) => [e.ref.index, e.pose.x]));
  assert.deepEqual([...xs].sort(), [[1, 2], [2, 2], [3, 2]], 'one frame, every actor, newest pose');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(bob.inbox.actorBatches.length, 0, 'more than one pending frame was queued');
  assert.equal(bob.isClosed, false);

  peer.close();
  bob.close();
  await Promise.all([peer.closed, bob.closed]);
});

test('a hidden tab is idle: streams held to the newest frame, no BACKLOG, avatar stands still', async (t) => {
  const server = await startServer({ requireGameData: false,
    dataDir: tmpDataDir(),
    port: 0,
    host: '127.0.0.1',
    configOverride: { limits: { maxConnsPerIp: 200, loginPerMinPerIp: 10_000 }, server: { password: PEER_PASS } },
  });
  t.after(() => server.close());
  let stalled = 0;
  Connection.bufferedAmountReader = (conn) => (conn.player?.name === 'hid_bob' ? stalled : undefined);
  t.after(() => { Connection.bufferedAmountReader = undefined; });

  const peer = await TestClient.simPeer(server.port, PEER_PASS, 'hid_peer');
  const bob = await TestClient.connect(server.port);
  const { playerId: bobId } = await bob.joinAsNew('hid_bob');
  await bob.waitEvent('PlayerList');
  const carol = await TestClient.connect(server.port);
  await carol.joinAsNew('hid_carol');
  await carol.waitEvent('PlayerList');
  peer.sendCellChange('94,94', 0, 0, 0);
  const epoch = ((await peer.waitEvent('ActorAuthorityGrant')).value as { epoch: number }).epoch;
  for (const c of [bob, carol]) {
    c.sendCellChange('94,94', 0, 0, 0);
    await c.waitEvent('ActorAuthorityInfo');
  }
  bob.sendMove({ x: 10, y: 0, z: 0, flags: 1, animVel: 120 });
  await carol.waitBatch((b) => b.entries.some((e) => e.id === bobId && e.pose.animVel === 120));
  // Past the cell-entry grace, so the hard ceiling would bite on a visible tab.
  await new Promise((r) => setTimeout(r, 2100));

  carol.inbox.batches.length = 0; // the join-time pose had animVel 0 too
  bob.sendEvent('ClientVisibility', { hidden: true });
  // Observers see the avatar stop: same spot, motion cleared.
  const idle = await carol.waitBatch((b) => b.entries.some((e) => e.id === bobId && e.pose.animVel === 0));
  const e = idle.entries.find((x) => x.id === bobId)!;
  assert.equal(e.pose.x, 10);
  assert.equal(e.pose.flags & 1, 0, 'still running in place');

  bob.inbox.actorBatches.length = 0;
  stalled = 1_048_577; // past maxBufferedBytesHard: a visible tab would be kicked
  for (let i = 0; i < 5; i++) peer.sendActorMoveBatch(epoch, [actor(1, i)]);
  await carol.waitActorBatch((b) => b.batch.entries[0]!.pose.x === 4);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(bob.isClosed, false, 'a hidden tab was kicked with BACKLOG');
  assert.equal(bob.inbox.actorBatches.length, 0, 'lossy frames went to a hidden tab');

  stalled = 0;
  bob.sendEvent('ClientVisibility', { hidden: false });
  const got = await bob.waitActorBatch();
  assert.equal(got.batch.entries[0]!.pose.x, 4, 'shown: the newest state');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(bob.inbox.actorBatches.length, 0, 'more than the newest frame was queued');

  for (const c of [peer, bob, carol]) c.close();
  await Promise.all([peer.closed, bob.closed, carol.closed]);
});
