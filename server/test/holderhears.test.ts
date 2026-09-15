// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// THE HOLDER HEARS ITS CELLS. The one peer anchors every occupied cell while its own avatar
// stands in one of them, and object relays were gated on the AVATAR's neighbourhood -- so a
// door opened in a far anchored interior stayed shut for the simulator's pathing, a lock
// picked there stayed locked for its guards. The holder of a cell hears that cell wherever it
// stands, and can ask for the cell's record (doors, locks, the dead) when it takes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const PEER_PASS = 'peer-secret-1';

test('a door opened in a held cell reaches the holder standing elsewhere, and the cell record names it', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS } },
  });
  t.after(() => server.close());
  const bob = await TestClient.connect(server.port);
  t.after(() => bob.close());
  await bob.joinAsNew('Bob');
  bob.sendCellChange('0,0', 0, 0, 0);
  await bob.waitEvent('PlayerCellChange');

  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  peer.sendCellChange('0,0', 0, 0, 0);
  await peer.waitEvent('ActorAuthorityGrant', (v) => (v as { cellKey: string }).cellKey === '0,0');
  // The avatar walks far away; Bob keeps 0,0 occupied, so the peer keeps holding it.
  peer.sendCellChange('9,9', 0, 0, 0);
  await peer.waitEvent('ActorAuthorityGrant', (v) => (v as { cellKey: string }).cellKey === '9,9');
  peer.inbox.events.length = 0;

  const doorRef = { __refnum: { index: 500, contentFile: 2 } };
  bob.sendEvent('DoorState', { ref: doorRef, cellKey: '0,0', open: true });
  const heard = await peer.waitEvent('DoorState', () => true, 3000);
  assert.equal((heard.value as { cellKey: string; open: boolean }).cellKey, '0,0', 'the holder hears the door it does not stand near');
  assert.equal((heard.value as { open: boolean }).open, true);

  // And the record, on request (what the peer's grant handler asks for).
  peer.sendEvent('ResyncRequest', { cellKey: '0,0' });
  const state = (await peer.waitEvent('WorldCellState', (v) => (v as { cellKey: string }).cellKey === '0,0')).value as { doors: Record<string, boolean> };
  assert.equal(state.doors['c:500:2'], true, 'the cell record carries the door state');

  // Control: a cell the peer neither holds nor stands near stays quiet.
  const carol = await TestClient.connect(server.port);
  t.after(() => carol.close());
  await carol.joinAsNew('Carol');
  carol.sendCellChange('20,20', 0, 0, 0);
  await carol.waitEvent('PlayerCellChange');
  peer.inbox.events.length = 0;
  carol.sendEvent('DoorState', { ref: doorRef, cellKey: '20,20', open: true });
  await carol.waitEvent('DoorState');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(peer.inbox.events.filter((e) => e.name === 'DoorState').length, 0, 'an unheld far cell is not relayed to the peer');
});
