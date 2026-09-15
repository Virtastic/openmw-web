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

// A SCRIPTED ENABLE HAS ONE OWNER. The peer runs the cell scripts authoritatively and every
// client runs a local copy; two engines disagreeing on a global flipped the same ref opposite
// ways once a second through this relay, forever. The peer's write wins for a window; a
// client's contrary write inside it is dropped, exactly as quest globals already work.
test("a client's enable/disable of a ref the peer just wrote is dropped; after the window it lands", async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS } },
  });
  t.after(() => server.close());
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  peer.sendCellChange('0,0', 0, 0, 0);
  await peer.waitEvent('ActorAuthorityGrant');
  const bob = await TestClient.connect(server.port);
  t.after(() => bob.close());
  await bob.joinAsNew('Bob');
  bob.sendCellChange('0,0', 0, 0, 0);
  await bob.waitEvent('PlayerCellChange');
  const watcher = await TestClient.connect(server.port);
  t.after(() => watcher.close());
  await watcher.joinAsNew('Watcher');
  watcher.sendCellChange('0,0', 0, 0, 0);
  await watcher.waitEvent('PlayerCellChange');

  const ref = { __refnum: { index: 700, contentFile: 0 } };
  watcher.inbox.events.length = 0;
  peer.sendEvent('ObjectEnabled', { ref, cellKey: '0,0', enabled: false }); // the script on the simulator
  await watcher.waitEvent('ObjectEnabled', (v) => (v as { enabled: boolean }).enabled === false);
  bob.sendEvent('ObjectEnabled', { ref, cellKey: '0,0', enabled: true }); // Bob's stale copy re-enables it
  await new Promise((r) => setTimeout(r, 300)); // object ops are queued; chat is not, so a chat fence proves nothing here
  assert.equal(watcher.inbox.events.filter((e) => e.name === 'ObjectEnabled' && (e.value as { enabled: boolean }).enabled === true).length, 0,
    "Bob's contrary write inside the peer's window was relayed: the ping-pong");
  // The record stays the peer's.
  bob.inbox.events.length = 0; // the cell state from Bob's own entry is still in the inbox
  bob.sendEvent('ResyncRequest', { cellKey: '0,0' });
  const state = (await bob.waitEvent('WorldCellState', (v) => (v as { cellKey: string }).cellKey === '0,0')).value as { disabled: string[] };
  assert.deepEqual(state.disabled, ['c:700:0']);
});

// WHAT YOU CAN SEE, NOT ONLY WHERE YOU STAND. An exterior loads its 3x3, and an item dropped
// near a border is recorded under the neighbour. Cell state went out for the entered cell
// only, so a friend arriving in the middle cell never saw the thing dropped for them until
// they crossed the line. Entry now yields the neighbours' records too, the entered cell first.
test('entering an exterior cell yields the neighbours\' records as well', async (t) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const dropper = await TestClient.connect(server.port);
  t.after(() => dropper.close());
  await dropper.joinAsNew('Dropper');
  dropper.sendCellChange('1,0', 0, 0, 0);
  await dropper.waitEvent('PlayerCellChange');
  dropper.sendEvent('ObjectSpawnRequest', { tempId: 1, recordId: 'gold_001', cellKey: '1,0', x: 4100, y: 10, z: 0, rotZ: 0, count: 5 });
  await dropper.waitEvent('ObjectSpawnAck');

  const friend = await TestClient.connect(server.port);
  t.after(() => friend.close());
  await friend.joinAsNew('Friend');
  await friend.waitEvent('PlayerList');
  friend.inbox.events.length = 0;
  friend.sendCellChange('0,0', 0, 0, 0);
  const first = (await friend.waitEvent('WorldCellState')).value as { cellKey: string };
  assert.equal(first.cellKey, '0,0', 'the entered cell comes first');
  const neighbour = (await friend.waitEvent('WorldCellState', (v) => (v as { cellKey: string }).cellKey === '1,0', 3000)).value as { placed: { recordId: string }[] };
  assert.equal(neighbour.placed[0]?.recordId, 'gold_001', 'the neighbour\'s record carries the drop');

  // An interior yields itself only.
  friend.inbox.events.length = 0;
  friend.sendCellChange('some tavern', 0, 0, 0);
  await friend.waitEvent('WorldCellState', (v) => (v as { cellKey: string }).cellKey === 'some tavern');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(friend.inbox.events.filter((e) => e.name === 'WorldCellState').length, 0, 'an interior has no neighbours');
});
