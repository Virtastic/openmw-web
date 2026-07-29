// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The shared PUBLIC world is a social lobby: its cells reset, so every container in it is an
// infinite faucet and noDrop only strips unique corpses. Nothing done there may write back to
// the character — you arrive with your gear and leave with exactly what you had.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir, readPlayerDoc } from './helpers';

test('the shared public world never writes to the character doc', async (t) => {
  const dataDir = tmpDataDir();

  // Own world first: that is where a character is made and where progress is real.
  const solo = await startServer({ dataDir, port: 0, host: '127.0.0.1', worldMode: 'private' });
  const a = await TestClient.connect(solo.port);
  const { welcome } = await a.joinAsNew('Looter');
  const charId = String(welcome['characterId']);
  await a.waitEvent('PlayerList');
  a.sendEvent('PlayerAppearance', {
    race: 'dark elf', head: 'h', hair: 'x', isMale: true, class: 'nightblade', name: 'Looter',
  });
  a.sendEvent('PlayerInventory', { items: [{ id: 'gold_001', n: 10 }] });
  a.close();
  await a.closed;
  await solo.flush();
  await solo.close();
  const saved = readPlayerDoc(dataDir, charId);
  assert.deepEqual(saved?.['inventory'], [{ id: 'gold_001', n: 10 }], 'solo progress must save');

  // Same character in the gateway-managed shared world: loot all it likes, nothing sticks.
  process.env.OMW_WORLD_ID = 'vvardenfell';
  t.after(() => { delete process.env.OMW_WORLD_ID; });
  const lobby = await startServer({ dataDir, port: 0, host: '127.0.0.1', worldMode: 'public' });
  t.after(() => lobby.close());
  const b = await TestClient.connect(lobby.port);
  b.hello();
  await b.waitJson('SessionHelloOk');
  b.login('Looter', 'hunter22');
  await b.waitJson('SessionWelcome');
  b.sendJson({ t: 'SessionReady' });
  await b.waitEvent('PlayerList');
  b.sendEvent('PlayerInventory', { items: [{ id: 'gold_001', n: 999999 }] });
  b.sendCellChange('0,0', 1, 2, 3);
  await b.waitEvent('PlayerCellChange');
  b.close();
  await b.closed;
  await lobby.flush();

  assert.deepEqual(readPlayerDoc(dataDir, charId)?.['inventory'], [{ id: 'gold_001', n: 10 }],
    'the lobby wrote to the character — every container there is a dupe faucet');
});
