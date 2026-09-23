// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The three peer-side gates no other test sent anything through (MP-READINESS-AUDIT item 3):
//  - a frame that throws inside the server drops a player at once, but the AUTHENTICATED sim
//    peer only after a run of them (connection.ts onMessage catch);
//  - a peer walking away keeps the cells that still hold players (authorityLeaveAll);
//  - a cell left with no holder loses the actors the peer named (purgeNamedActors).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type RunningServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const PASS = 'peer-gates-1';

type World = { drain(): Promise<void>; authority: { holderOf(c: string): number | undefined; currentEpoch(c: string): number | undefined } };
type Conn = { onText(text: string): void; ctx: { world: World } };

const connOf = (server: RunningServer, id: number): Conn =>
  server.roster.inWorld().find((p) => p.id === id)!.peer as unknown as Conn;

const boot = async (t: test.TestContext) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PASS }, limits: { maxConnsPerIp: 8 } } });
  t.after(() => server.close());
  return server;
};

// Every frame from this connection throws a non-protocol error until the returned undo runs.
const throwing = (conn: Conn): (() => void) => {
  const own = Object.getOwnPropertyDescriptor(conn, 'onText');
  conn.onText = () => { throw new Error('boom'); };
  return () => { if (own) Object.defineProperty(conn, 'onText', own); else delete (conn as Partial<Conn>).onText; };
};

test('an internal error drops a player at once; the sim peer survives twenty and is dropped on the 21st', async (t) => {
  const server = await boot(t);

  const player = await TestClient.connect(server.port);
  t.after(() => player.close());
  const { playerId } = await player.joinAsNew('Thrower');
  await player.waitEvent('PlayerList');
  throwing(connOf(server, playerId));
  player.sendJson({ t: 'SessionReady' });
  const dropped = await player.closed;
  assert.equal(dropped.reason, 'BAD_PROTO', 'one throwing frame disconnects a player');

  const peer = await TestClient.simPeer(server.port, PASS, 'Peer');
  t.after(() => peer.close());
  peer.sendCellChange('0,0', 0, 0, 0);
  await peer.waitEvent('PlayerCellChange');
  const conn = connOf(server, peer.playerId);
  const undo = throwing(conn);
  for (let i = 0; i < 20; i++) peer.sendJson({ t: 'SessionReady' });
  // Still connected: a real frame after the run is answered.
  await new Promise((r) => setTimeout(r, 200));
  undo();
  peer.inbox.events.length = 0;
  peer.sendCellChange('1,0', 0, 0, 0);
  await peer.waitEvent('PlayerCellChange');

  throwing(conn);
  for (let i = 0; i < 21; i++) peer.sendJson({ t: 'SessionReady' });
  const gone = await Promise.race([peer.closed, new Promise<{ reason: string }>((r) => setTimeout(() => r({ reason: 'still connected' }), 3000))]);
  assert.equal(gone.reason, 'BAD_PROTO'); // the 21st consecutive (session-total) error drops even the peer
});

test('a peer walking away keeps an occupied cell, and releases (and purges) an empty one', async (t) => {
  const server = await boot(t);
  const peer = await TestClient.simPeer(server.port, PASS, 'Peer');
  t.after(() => peer.close());
  const cellIs = (k: string) => (v: unknown) => (v as { cellKey?: string }).cellKey === k;

  // EMPTY: the peer names a levelled creature in 5,5 with nobody else there, then walks on.
  peer.sendCellChange('5,5', 0, 0, 0);
  await peer.waitEvent('ActorAuthorityGrant', cellIs('5,5'));
  const world = connOf(server, peer.playerId).ctx.world;
  peer.sendEvent('ObjectSpawnRequest', { tempId: 1, recordId: 'cliff racer', cellKey: '5,5', x: 1, y: 2, z: 3, rotZ: 0, count: 1, actor: true });
  await peer.waitEvent('ObjectSpawnAck');

  // OCCUPIED: the peer then stands in 0,0 with a player.
  peer.sendCellChange('0,0', 0, 0, 0);
  await peer.waitEvent('ActorAuthorityGrant', cellIs('0,0'));
  await world.drain();
  assert.equal(world.authority.holderOf('5,5'), undefined, 'the empty cell was released as the peer left it');

  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Stayer');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);
  await b.waitEvent('ActorAuthorityInfo', cellIs('0,0'));
  await world.drain();
  const epochBefore = world.authority.currentEpoch('0,0');
  assert.equal(world.authority.holderOf('0,0'), peer.playerId);

  peer.sendCellChange('20,20', 0, 0, 0);
  await peer.waitEvent('PlayerCellChange', cellIs('20,20'));
  await world.drain();
  assert.equal(world.authority.holderOf('0,0'), peer.playerId, 'the occupied cell kept its holder');
  assert.equal(world.authority.currentEpoch('0,0'), epochBefore, 'no release + re-grant: the epoch did not move');

  // What a player walking into 5,5 is told: the named creature went with its holder.
  b.inbox.events.length = 0;
  b.sendCellChange('5,5', 0, 0, 0);
  const state = (await b.waitEvent('WorldCellState', cellIs('5,5'))).value as { placed: unknown[] };
  assert.equal(state.placed.length, 0, 'the named actor was purged with the release');
});
