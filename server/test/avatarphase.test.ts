// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-207: the peer learns each player's phase for the cell they enter, so it can tag the
// avatar; with no phase hook (every world today) PlayerCellChange is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { avatarPhaseEvent } from '../src/phase/peertags';
import { TestClient, tmpDataDir } from './helpers';

const PEER_PASS = 'peer-secret-1';

test('PlayerCellChange to the peer carries the mover\'s phase; players never see it', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS } },
  });
  t.after(() => server.close());
  server.world.playerPhaseKey = (_charId, cellKey) => (cellKey === 'Raven Rock' ? 'colony2' : undefined);
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  const watcher = await TestClient.connect(server.port);
  t.after(() => watcher.close());
  await watcher.joinAsNew('Watcher');
  watcher.sendCellChange('Raven Rock', 0, 0, 0);
  const mover = await TestClient.connect(server.port);
  t.after(() => mover.close());
  await mover.joinAsNew('Mover');
  await new Promise((r) => setTimeout(r, 200));
  peer.inbox.events.length = 0;
  watcher.inbox.events.length = 0;
  mover.sendCellChange('Raven Rock', 10, 10, 0);
  const atPeer = await peer.waitEvent('PlayerCellChange', (v) => (v as { cellKey: string }).cellKey === 'Raven Rock');
  assert.equal((atPeer.value as { phase?: string }).phase, 'colony2');
  const atWatcher = await watcher.waitEvent('PlayerCellChange');
  assert.equal((atWatcher.value as { phase?: string }).phase, undefined);
  mover.sendCellChange('0,0', 10, 10, 0);
  const plain = await peer.waitEvent('PlayerCellChange', (v) => (v as { cellKey: string }).cellKey === '0,0');
  assert.equal('phase' in (plain.value as object), false);
});

test('avatarPhaseEvent clears with an empty key', () => {
  assert.deepEqual(avatarPhaseEvent(7, 'colony2'), ['AvatarPhase', { id: 7, phase: 'colony2' }]);
  assert.deepEqual(avatarPhaseEvent(7, undefined), ['AvatarPhase', { id: 7, phase: '' }]);
});
