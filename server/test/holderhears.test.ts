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

// EPOCHS NAME CELLS. An ActorMoveBatch carries an epoch and no cell key, and the server keyed
// every batch on the holder's OWN cell: the one peer anchors many cells while its avatar
// stands in one, so every other cell's stream was refused as stale (frozen NPCs everywhere
// the avatar was not). Epochs come from one counter now, so the epoch says which cell.
test("the peer's actor batches for a far held cell reach the players standing there", async (t) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1', configOverride: { server: { password: PEER_PASS } } });
  t.after(() => server.close());
  const carol = await TestClient.connect(server.port);
  t.after(() => carol.close());
  await carol.joinAsNew('Carol');
  carol.sendCellChange('0,0', 0, 0, 0);
  await carol.waitEvent('PlayerCellChange');
  const bob = await TestClient.connect(server.port);
  t.after(() => bob.close());
  await bob.joinAsNew('Bob');
  bob.sendCellChange('9,9', 0, 0, 0);
  await bob.waitEvent('PlayerCellChange');

  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  peer.sendCellChange('0,0', 0, 0, 0);
  const e1 = ((await peer.waitEvent('ActorAuthorityGrant', (v) => (v as { cellKey: string }).cellKey === '0,0')).value as { epoch: number }).epoch;
  peer.sendCellChange('9,9', 0, 0, 0); // Carol keeps 0,0 occupied, so the peer keeps holding it
  const e2 = ((await peer.waitEvent('ActorAuthorityGrant', (v) => (v as { cellKey: string }).cellKey === '9,9')).value as { epoch: number }).epoch;
  assert.notEqual(e1, e2, 'epochs are unique across cells');

  const entry = { ref: { index: 42, contentFile: 0 }, pose: { x: 1, y: 2, z: 3, yaw: 0, pitch: 0, flags: 0, animVel: 0, counter: 0 } };
  peer.sendActorMoveBatch(e1, [entry]); // the cell the avatar LEFT
  const got = await carol.waitActorBatch();
  assert.equal(got.batch.epoch, e1, 'Carol, standing in 0,0, gets the 0,0 stream');
  peer.sendActorMoveBatch(e2, [entry]);
  assert.equal((await bob.waitActorBatch()).batch.epoch, e2, 'Bob gets the 9,9 stream');
});

// LOD IS MEASURED FROM THE STREAMED CELL. The peer's dummy stands wherever it last walked;
// the server measured actor LOD from THAT pose, so a player in another exterior cell got the
// NPCs in their OWN cell at the far rate (1 Hz: park, stutter, teleport). A recipient standing
// in the streamed cell is never strided, however far the dummy is parked.
test("a player far from the peer's dummy gets every batch for the cell they stand in", async (t) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1', configOverride: { server: { password: PEER_PASS } } });
  t.after(() => server.close());
  const bob = await TestClient.connect(server.port);
  t.after(() => bob.close());
  await bob.joinAsNew('Bob');
  bob.sendCellChange('0,0', 4096, 4096, 0);
  await bob.waitEvent('PlayerCellChange');

  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  peer.sendCellChange('0,0', 4096, 4096, 0);
  const e = ((await peer.waitEvent('ActorAuthorityGrant', (v) => (v as { cellKey: string }).cellKey === '0,0')).value as { epoch: number }).epoch;
  // The dummy walks off to the next cell, far past lodMidRadius from Bob; 0,0 stays held
  // because Bob keeps it occupied.
  peer.sendCellChange('1,0', 8192 + 8000, 4096, 0);
  await peer.waitEvent('ActorAuthorityGrant', (v) => (v as { cellKey: string }).cellKey === '1,0');
  await peer.waitEvent('PlayerCellChange');

  const entry = { ref: { index: 42, contentFile: 0 }, pose: { x: 1, y: 2, z: 3, yaw: 0, pitch: 0, flags: 0, animVel: 0, counter: 0 } };
  bob.inbox.actorBatches.length = 0;
  for (let i = 0; i < 10; i++) peer.sendActorMoveBatch(e, [entry]);
  for (let i = 0; i < 10; i++) await bob.waitActorBatch((b) => b.batch.epoch === e);
});

// THE RING AROUND A HELD EXTERIOR. The peer's engine loads the 3x3 around every anchor and
// runs AI there, like the anchoring player's own engine does -- but relays reached it only
// for the cell it HELD. A door opened one cell over stayed shut on the peer, its NPCs pathed
// around it and the avatar walked into what the player could not see.
test('the holder hears the exterior neighbours of a held cell, and nothing past them', async (t) => {
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
  peer.sendCellChange('9,9', 0, 0, 0); // the avatar is far away: only the hold can explain hearing
  await peer.waitEvent('ActorAuthorityGrant', (v) => (v as { cellKey: string }).cellKey === '9,9');

  const carol = await TestClient.connect(server.port);
  t.after(() => carol.close());
  await carol.joinAsNew('Carol');
  carol.sendCellChange('1,1', 0, 0, 0);
  await carol.waitEvent('PlayerCellChange');
  peer.inbox.events.length = 0;
  const doorRef = { __refnum: { index: 501, contentFile: 2 } };
  carol.sendEvent('DoorState', { ref: doorRef, cellKey: '1,1', open: true });
  const heard = await peer.waitEvent('DoorState', () => true, 3000).catch(() => assert.fail('a door in the ring never reached the peer'));
  assert.equal((heard.value as { cellKey: string }).cellKey, '1,1');

  // Two cells out is beyond the peer's grid: still quiet.
  carol.sendCellChange('2,1', 0, 0, 0);
  await new Promise((r) => setTimeout(r, 200));
  peer.inbox.events.length = 0;
  carol.sendEvent('DoorState', { ref: doorRef, cellKey: '2,1', open: true });
  await carol.waitEvent('DoorState', (v) => (v as { cellKey: string }).cellKey === '2,1');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(peer.inbox.events.filter((e) => e.name === 'DoorState').length, 0, 'a cell two out is not relayed to the peer');
});

// What happened in the ring BEFORE the peer heard it lives only in the cell doc. The anchored
// cell asks for its own record on the grant; the pass sends the neighbours'.
// The 3x3 around a player is HELD now (server.ts heldRing): the peer owns those NPCs and gets
// each cell's record the way every held cell does, by asking on its grant. The pushed record
// is for the ring BEYOND that -- cells it hears but does not hold.
test('on the wire: the peer holds the 3x3 around a player, and is sent the record of the ring beyond it', async (t) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS }, limits: { maxConnsPerIp: 16 } } });
  t.after(() => server.close());
  const bob = await TestClient.connect(server.port);
  t.after(() => bob.close());
  await bob.joinAsNew('Bob');
  bob.sendCellChange('0,0', 100, 100, 0);
  await bob.waitEvent('PlayerCellChange');
  // Bob opens a door two cells out before any peer exists (he can see it: cellsVisible is the
  // player's own 3x3, and 2,0 is the peer's ring once it holds 1,0).
  bob.sendCellChange('1,0', 8292, 100, 0);
  await bob.waitEvent('PlayerCellChange', (v) => (v as { cellKey: string }).cellKey === '1,0');
  bob.sendEvent('DoorState', { ref: { __refnum: { index: 502, contentFile: 2 } }, cellKey: '2,0', open: true });
  await bob.waitEvent('DoorState', (v) => (v as { cellKey: string }).cellKey === '2,0');
  bob.sendCellChange('0,0', 100, 100, 0);
  await bob.waitEvent('PlayerCellChange', (v) => (v as { cellKey: string }).cellKey === '0,0');

  server.config.simPeer.enabled = true; // no binary: the pass talks to the TestClient peer
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  await peer.waitEvent('ActorAuthorityGrant', (v) => (v as { cellKey: string }).cellKey === '1,0', 14_000)
    .catch(() => assert.fail('the peer was not given the neighbour cell: NPCs there run twice'));
  const state = (await peer.waitEvent('WorldCellState', (v) => (v as { cellKey: string }).cellKey === '2,0', 14_000)
    .catch(() => assert.fail('the ring record never reached the peer'))).value as { doors: Record<string, boolean> };
  assert.equal(state.doors['c:502:2'], true, 'the peer learns the door was opened');
});
