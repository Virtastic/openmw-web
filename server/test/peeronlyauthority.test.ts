// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// ONLY the sim peer simulates. This is the whole multiplayer contract for NPCs: players see
// one shared simulation driven by the server, and a player's machine can never author actor
// state for anyone else.
//
// It is tested here because it was NOT tested anywhere: eligibility used to be tied to
// auth.requireSso, which defaults to FALSE, so the entire suite ran in the legacy
// client-authority mode while production ran peer-only. A peer that never authenticated
// therefore left every cell holderless — no actor traffic at all — and 512 green tests said
// nothing about it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

test('a player never holds a cell, and the sim peer does', async (t) => {
  const dataDir = tmpDataDir();
  const PEER_PASS = 'peer-secret-1';
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS } },
  });
  t.after(() => server.close());

  // A player alone in a cell. Under client authority this player was granted it.
  const alice = await TestClient.connect(server.port);
  await alice.joinAsNew('Alice');
  await alice.waitEvent('PlayerList');
  alice.sendCellChange('0,0', 0, 0, 0);
  await alice.waitEvent('PlayerCellChange');

  await assert.rejects(
    alice.waitEvent('ActorAuthorityGrant', () => true, 700),
    'a player is never granted authority, even alone in the cell',
  );

  // The peer arrives and takes it.
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  peer.sendCellChange('0,0', 0, 0, 0);
  const grant = await peer.waitEvent('ActorAuthorityGrant');
  assert.equal((grant.value as { cellKey: string }).cellKey, '0,0');

  // ...and the player is told who holds it, so it can address actors for combat.
  const info = await alice.waitEvent('ActorAuthorityInfo');
  assert.equal((info.value as { cellKey: string }).cellKey, '0,0');
  assert.equal((info.value as { holderId: number }).holderId, peer.playerId);
});

test('a peer holds only its own cell; a neighbour is left unheld, not silently unsimulated', async (t) => {
  const dataDir = tmpDataDir();
  const PEER_PASS = 'peer-secret-1';
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS } },
  });
  t.after(() => server.close());

  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  peer.sendCellChange('0,0', 0, 0, 0);
  await peer.waitEvent('ActorAuthorityGrant', (v) => (v as { cellKey: string }).cellKey === '0,0');

  // The adjacent cell is LOADED by the engine but outside its 7168-unit actor processing
  // radius (a cell is 8192 wide), so the peer must not be credited with it. An unheld cell is
  // visible; a held-but-unsimulated one is a silent freeze nothing can detect.
  const neighbour = await TestClient.connect(server.port);
  await neighbour.joinAsNew('Neighbour');
  await neighbour.waitEvent('PlayerList');
  neighbour.sendCellChange('1,0', 0, 0, 0);
  await neighbour.waitEvent('PlayerCellChange');
  await assert.rejects(
    neighbour.waitEvent('ActorAuthorityInfo', (v) => (v as { cellKey: string }).cellKey === '1,0', 1200),
    'an adjacent cell must be left unheld until a peer actually covers it',
  );
});
