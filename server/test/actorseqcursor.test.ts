// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// THE CLIENT'S SHARED STALE-DROP CURSOR (netmanager.cpp mLastMoveSeqIn) must pass every NPC
// batch. PlayerStateBatch (own pose), PlayerMoveBatch and ActorMoveBatch share ONE cursor on
// the client: `if (seq <= last) drop`. A solo player in a peer-held cell receives the first
// and the last interleaved; replaying the arrival order through that exact rule must keep
// every actor batch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';
import { unpackEnvelope, MSG_PLAYER_MOVE_BATCH, MSG_ACTOR_MOVE_BATCH } from '../src/proto/envelope';
import { MSG_PLAYER_STATE_BATCH } from '../src/proto/input';

const PEER_PASS = 'peer-secret-1';
const pose = { x: 512, y: 640, z: 10, yaw: 0, pitch: 128, flags: 0, animVel: 0, counter: 0 };

test('solo player in a held cell: every relayed actor batch survives the shared seq cursor', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS }, limits: { maxConnsPerIp: 16 } },
  });
  t.after(() => server.close());
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  const welcome = await a.joinAsNew('Solo');
  a.playerId = welcome['playerId'] as number;
  await a.waitEvent('PlayerList');

  // What the browser's NetManager sees, in arrival order.
  const lossy: { type: number; seq: number }[] = [];
  a.ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (!isBinary) return;
    const env = unpackEnvelope(data);
    if (env.type === MSG_PLAYER_MOVE_BATCH || env.type === MSG_ACTOR_MOVE_BATCH || env.type === MSG_PLAYER_STATE_BATCH) {
      lossy.push({ type: env.type, seq: env.seq });
    }
  });

  a.sendCellChange('0,0', 512, 640, 10);
  peer.sendCellChange('0,0', 0, 0, 0);
  const grant = await peer.waitEvent('ActorAuthorityGrant', (v) => (v as { cellKey: string }).cellKey === '0,0');
  const epoch = (grant.value as { epoch: number }).epoch;

  // Own-pose stream (PlayerStateBatch needs fresh input + fresh peer poses) and the NPC stream.
  let inputSeq = 0;
  const timers = [
    setInterval(() => a.sendInput({ move: 1 }, ++inputSeq), 50),
    setInterval(() => peer.sendAvatarMoveBatch([{ id: a.playerId, lastInputSeq: inputSeq, pose }]), 50),
    setInterval(() => peer.sendActorMoveBatch(epoch, [{ ref: { index: 7, contentFile: 0 }, pose }]), 33),
  ];
  t.after(() => timers.forEach(clearInterval));
  await new Promise((r) => setTimeout(r, 3000));
  timers.forEach(clearInterval);

  let cursor = 0;
  const kept = { [MSG_ACTOR_MOVE_BATCH]: 0, [MSG_PLAYER_STATE_BATCH]: 0, [MSG_PLAYER_MOVE_BATCH]: 0 } as Record<number, number>;
  const seen = { ...kept };
  for (const f of lossy) {
    seen[f.type]!++;
    if (f.seq <= cursor) continue;
    cursor = f.seq;
    kept[f.type]!++;
  }
  t.diagnostic(`seen ${JSON.stringify(seen)} kept ${JSON.stringify(kept)}`);
  assert.ok(seen[MSG_PLAYER_STATE_BATCH]! > 0, 'own-pose stream flowed (the control)');
  assert.ok(seen[MSG_ACTOR_MOVE_BATCH]! > 20, 'the server relayed the NPC stream to the solo player');
  assert.equal(kept[MSG_ACTOR_MOVE_BATCH], seen[MSG_ACTOR_MOVE_BATCH], 'the shared cursor dropped actor batches');
  assert.equal(kept[MSG_PLAYER_STATE_BATCH], seen[MSG_PLAYER_STATE_BATCH]);
});
