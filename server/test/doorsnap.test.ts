// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// "Snapped back to the door after a slow cell load": the peer's avatar spawns at the doorway
// seconds after the client has walked on. The server must move the AVATAR to the player
// (bounded by walking reach), not reconcile the player back to the door.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const PEER_PASS = 'peer-secret-1';
const INTERIOR = "Seyda Neen, Arrille's Tradehouse";
const pose = (x: number) => ({ x, y: 0, z: 0, yaw: 0, pitch: 128, flags: 0, animVel: 0, counter: 0 });

async function doorThenWalk(t: { after(fn: () => unknown): void }, walkTo: number) {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS }, limits: { maxConnsPerIp: 16 } },
  });
  t.after(() => server.close());
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  a.playerId = (await a.joinAsNew('Walker'))['playerId'] as number;
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 512, 640, 10);
  await new Promise((r) => setTimeout(r, 200));
  const inputTimer = setInterval(() => a.sendInput({ move: 1 }), 100);
  t.after(() => clearInterval(inputTimer));

  // Through the door; the peer is loading the interior, the client walks on meanwhile.
  a.sendCellChange(INTERIOR, 0, 0, 0);
  for (let i = 1; i <= 15; i++) {
    await new Promise((r) => setTimeout(r, 100));
    a.sendMove(pose((walkTo * i) / 15));
  }
  await new Promise((r) => setTimeout(r, 100));
  peer.inbox.events.length = 0;
  a.inbox.stateBatches.length = 0;

  // The load finishes: the avatar appears AT THE DOOR having consumed the latest input.
  const me = server.roster.get(a.playerId)!;
  const streamTimer = setInterval(() => peer.sendAvatarMoveBatch([
    { id: a.playerId!, lastInputSeq: me.inputSeq ?? 0, pose: pose(0) },
  ]), 60);
  t.after(() => clearInterval(streamTimer));
  await new Promise((r) => setTimeout(r, 800));
  clearInterval(streamTimer);
  const snapped = a.inbox.stateBatches.some((sb) => sb.entries.some((e) => e.id === a.playerId && Math.abs(e.pose.x) < 1));
  const moved = peer.inbox.events.find((e) => e.name === 'PlayerCellChange'
    && (e.value as { id: number }).id === a.playerId) as { value: { cellKey: string; x: number } } | undefined;
  return { snapped, moved };
}

test('a slow interior load moves the avatar to the player, not the player to the door', async (t) => {
  const { snapped, moved } = await doorThenWalk(t, 900);
  assert.equal(snapped, false, 'the owner must not be reconciled back to the doorway');
  assert.ok(moved, 'the peer must be told to move the avatar to where the player walked');
  assert.equal(moved.value.cellKey, INTERIOR);
  assert.ok(Math.abs(moved.value.x - 900) < 1);
});

test('a claim beyond walking reach is not honoured: the door pose rules', async (t) => {
  const { snapped, moved } = await doorThenWalk(t, 6000); // 6000 u in ~1.6 s: not a walk
  assert.equal(moved, undefined, 'no rebase for an implausible claim');
  assert.equal(snapped, true, 'the peer pose is canonical again');
});
