// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 3 input tier: the server is a ROUTER for movement now, not a believer. A player's
// PlayerInput frames go to the world peer; the peer's AvatarMoveBatch is the authoritative
// pose everyone renders; the owner gets a PlayerStateBatch (pose + lastInputSeq) to
// reconcile against. And the negative control: only the world peer may author avatar poses.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';
import { metrics } from '../src/metrics';

const PEER_PASS = 'peer-secret-1';

async function poll<T>(pick: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = pick();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function world(t: { after(fn: () => unknown): void }) {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS }, limits: { maxConnsPerIp: 16 } },
  });
  t.after(() => server.close());
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  const welcomeA = await a.joinAsNew('Runner');
  a.playerId = welcomeA['playerId'] as number;
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  return { server, peer, a };
}

test('PlayerInput is forwarded to the world peer, stamped with the owning id', async (t) => {
  const { peer, a } = await world(t);
  a.sendInput({ move: 1, flags: 1 /* run */ }, 42);
  const fwd = await poll(() => {
    const i = peer.inbox.inputForwards.findIndex((f) => f.id === a.playerId);
    return i === -1 ? undefined : peer.inbox.inputForwards.splice(i, 1)[0];
  }, 8000, 'forwarded input');
  assert.equal(fwd.id, a.playerId, 'the peer must know WHOSE avatar to steer');
  assert.ok(Math.abs(fwd.input.move - 1) < 0.01);
  assert.equal(fwd.input.flags & 1, 1, 'the run flag survived the trip');
});

test('the peer\'s AvatarMoveBatch is the pose everyone sees, and the owner reconciles', async (t) => {
  const { server, peer, a } = await world(t);
  // A second player to observe the fan-out.
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Watcher');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);

  peer.sendAvatarMoveBatch([
    { id: a.playerId, lastInputSeq: 77, pose: { x: 512, y: 640, z: 10, yaw: 0, pitch: 128, flags: 0, animVel: 0, counter: 0 } },
  ]);

  // The watcher renders the authoritative pose through the ORDINARY move batch channel.
  const seen = await b.waitBatch(
    (bt) => bt.entries.some((e) => e.id === a.playerId && Math.round(e.pose.x) === 512), 8000);
  assert.ok(seen, 'the peer-authored pose never reached other players');

  // The owner gets their own entry back with the consumed input seq — the reconciliation
  // anchor. The peer keeps streaming, so keep the pose fresh through the broadcast tick.
  const streamTimer = setInterval(() => peer.sendAvatarMoveBatch([
    { id: a.playerId, lastInputSeq: 77, pose: { x: 512, y: 640, z: 10, yaw: 0, pitch: 128, flags: 0, animVel: 0, counter: 0 } },
  ]), 60);
  t.after(() => clearInterval(streamTimer));
  const state = await poll(() => {
    const i = a.inbox.stateBatches.findIndex((sb) => sb.entries.some((e) => e.id === a.playerId));
    return i === -1 ? undefined : a.inbox.stateBatches.splice(i, 1)[0];
  }, 8000, 'player state batch');
  const mine = state.entries.find((e) => e.id === a.playerId)!;
  assert.equal(mine.lastInputSeq, 77, 'reconciliation hangs off the consumed input seq');
  assert.equal(Math.round(mine.pose.x), 512);
});

test('a CLIENT sending AvatarMoveBatch is refused and counted; the real peer still lands', async (t) => {
  const { peer, a } = await world(t);
  const before = (metrics.avatarBatchRejected.get({ reason: 'not_peer' }) ?? 0);

  // The forgery: a client claims to author avatar poses.
  a.sendAvatarMoveBatch([
    { id: a.playerId, lastInputSeq: 1, pose: { x: 99999, y: 0, z: 0, yaw: 0, pitch: 128, flags: 0, animVel: 0, counter: 0 } },
  ]);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((metrics.avatarBatchRejected.get({ reason: 'not_peer' }) ?? 0), before + 1,
    'the forged batch must be counted, mirroring actor_batch_rejected{not_holder}');

  // The real peer's frame still lands after the forgery.
  peer.sendAvatarMoveBatch([
    { id: a.playerId, lastInputSeq: 5, pose: { x: 256, y: 0, z: 0, yaw: 0, pitch: 128, flags: 0, animVel: 0, counter: 0 } },
  ]);
  const streamTimer = setInterval(() => peer.sendAvatarMoveBatch([
    { id: a.playerId, lastInputSeq: 5, pose: { x: 256, y: 0, z: 0, yaw: 0, pitch: 128, flags: 0, animVel: 0, counter: 0 } },
  ]), 60);
  t.after(() => clearInterval(streamTimer));
  const state = await poll(() => {
    const i = a.inbox.stateBatches.findIndex((sb) => sb.entries.some((e) => Math.round(e.pose.x) === 256));
    return i === -1 ? undefined : a.inbox.stateBatches.splice(i, 1)[0];
  }, 8000, 'authentic state batch');
  assert.ok(state, 'the real peer was blocked by the forgery');
});

test('with no peer, input is dropped and the client-authored path stays live (degraded mode)', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { limits: { maxConnsPerIp: 16 } },
  });
  t.after(() => server.close());
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  const welcome = await a.joinAsNew('Alone');
  a.playerId = welcome['playerId'] as number;
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);

  const before = (metrics.playerInputDropped.get({ reason: 'no_peer' }) ?? 0);
  a.sendInput({ move: 1 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((metrics.playerInputDropped.get({ reason: 'no_peer' }) ?? 0), before + 1);

  // The old path still works: a watcher sees the client-authored move.
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Watcher2');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);
  a.sendMove({ x: 321, y: 0, z: 0 });
  const seen = await b.waitBatch(
    (bt) => bt.entries.some((e) => e.id === a.playerId && Math.round(e.pose.x) === 321), 8000);
  assert.ok(seen, 'degraded mode must keep everyone moving');
});
