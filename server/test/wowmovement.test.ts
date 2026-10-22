// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// THE WOW MODEL ([limits] clientAuthority = true, the default since 2026-10-22). Each player's
// own client owns its position: the server validates a move and relays it, and the sim peer
// stands the avatar where the client put it. The peer's own avatar stream then describes that
// same spot a few frames late, so it must not become the pose anyone sees, and the owner gets
// no reconcile stream (only a correction when a move is refused; see moveenforce.test.ts).

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

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

test('WoW model: an accepted move reaches the peer at once, and the peer cannot override it', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS }, limits: { maxConnsPerIp: 16 } },
  });
  t.after(() => server.close());
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  const w = await a.joinAsNew('Walker');
  assert.equal((w.welcome['flags'] as { clientAuthority?: boolean }).clientAuthority, true, 'the client is told which model runs');
  a.playerId = w.playerId;
  await a.waitEvent('PlayerList');
  a.sendCellChange('5,5', 100, 100, 10);
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  b.playerId = (await b.joinAsNew('Watcher')).playerId;
  await b.waitEvent('PlayerList');
  b.sendCellChange('5,5', 0, 0, 10);
  await new Promise((r) => setTimeout(r, 250));

  // Inputs keep flowing (they swing, aim and ready the avatar) -- and a move.
  a.sendInput({ move: 1 }, 1);
  peer.inbox.batches.length = 0;
  a.sendMove({ x: 140, y: 100, z: 10 });
  const fwd = await poll(() => peer.inbox.batches.find((x) => x.entries.some((e) => e.id === a.playerId && Math.abs(e.pose.x - 140) < 0.01)),
    2000, 'the peer to hear the accepted move');
  assert.ok(fwd, 'the move was forwarded to the peer');

  // The peer reports its avatar a few frames behind. Under the WoW model nobody sees that.
  b.inbox.batches.length = 0;
  peer.sendAvatarMoveBatch([{ id: a.playerId!, lastInputSeq: 1, pose: { x: 900, y: 900, z: 10, yaw: 0, pitch: 0, flags: 0, animVel: 0, counter: 0 } }]);
  a.sendMove({ x: 180, y: 100, z: 10 });
  const seen = await poll(() => b.inbox.batches.flatMap((x) => x.entries).find((e) => e.id === a.playerId), 2000, 'the watcher to see Walker');
  assert.ok(Math.abs(seen.pose.x - 900) > 1, `the peer's late avatar pose became Walker's pose for the watcher (${seen.pose.x})`);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(a.inbox.stateBatches.length, 0, 'no reconcile stream: the owner is only corrected when a move is refused');
});
