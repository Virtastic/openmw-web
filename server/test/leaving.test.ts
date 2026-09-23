// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
//
// Exit is a DELIBERATE departure: the page sends PlayerLeaving and navigates away. The server
// used to wait for the socket close to take the character out of the world, and behind a proxy
// that close only came when the keepalive gave up -- 86 s on the dev box, during which the
// character stood in the world and could not be deleted (2026-09-23).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

test('PlayerLeaving takes the character out of the world at once, without waiting for the socket', async (t) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  const { playerId } = await a.joinAsNew('Leaver');
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  await a.waitEvent('PlayerCellChange');
  assert.ok(server.roster.get(playerId as number)?.inWorld, 'joined');

  a.sendEvent('PlayerLeaving', {});
  const until = Date.now() + 3000;
  while (server.roster.get(playerId as number)?.inWorld && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  assert.ok(!server.roster.get(playerId as number)?.inWorld, 'still in the world after saying it was leaving');
});
