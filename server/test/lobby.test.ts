// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The shared PUBLIC world is a social lobby: its cells reset, so QUEST PROGRESS and STANDING
// earned there are meaningless and must not follow you home. Your character otherwise does —
// what you carry, what you have learned, where you stood.
//
// It used to withhold EVERY write instead, as a duplicate-item firewall. That duplicated
// items rather than preventing them: a withheld write is a withheld LOSS, so something
// dropped in the shared world stayed on the ground there while the doc still claimed the
// player carried it, and going home granted it straight back. Quests and standing are now
// routed to nobody here (journalTarget, server.ts) and everything else is ordinary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir, readPlayerDoc } from './helpers';

test('the shared world keeps what you carry, and refuses quest progress', async (t) => {
  const dataDir = tmpDataDir();

  // Own world first: that is where a character is made and where progress is real.
  const solo = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: 'private' });
  const a = await TestClient.connect(solo.port);
  const { welcome } = await a.joinAsNew('Looter');
  const charId = String(welcome['characterId']);
  await a.waitEvent('PlayerList');
  a.sendEvent('PlayerAppearance', {
    race: 'dark elf', head: 'h', hair: 'x', isMale: true, class: 'nightblade', name: 'Looter',
  });
  // A character still IN creation has every write withheld, deliberately. Finish it, or this
  // test measures the chargen guard instead of the lobby rule.
  a.sendEvent('ChargenComplete', {});
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
  const lobby = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: 'public' });
  t.after(() => lobby.close());
  const b = await TestClient.connect(lobby.port);
  b.hello();
  await b.waitJson('SessionHelloOk');
  b.login('Looter', 'hunter22');
  await b.waitJson('SessionWelcome');
  b.sendJson({ t: 'SessionReady' });
  await b.waitEvent('PlayerList');
  b.sendEvent('PlayerInventory', { items: [{ id: 'gold_001', n: 25 }] });
  // Standing is routed like the journal now, so neither may survive the trip.
  b.sendEvent('FactionUpdate', { factionId: 'fightersguild', rank: 9 });
  b.sendEvent('CrimeUpdate', { bounty: 4000 });
  b.sendCellChange('0,0', 1, 2, 3);
  await b.waitEvent('PlayerCellChange');
  b.close();
  await b.closed;
  await lobby.flush();

  const after = readPlayerDoc(dataDir, charId);
  // What you are CARRYING is yours wherever you go — including a loss. Withholding this is
  // what let one item exist in two worlds at once.
  assert.deepEqual(after?.['inventory'], [{ id: 'gold_001', n: 25 }],
    'the shared world must record what the character is actually carrying');
  // ...but nothing that amounts to campaign progress.
  assert.equal(after?.['factions'], undefined, 'a guild rank earned in the shared world followed the player home');
  assert.equal(after?.['bounty'], undefined, 'a bounty earned in the shared world followed the player home');
});

// WHERE you stood is kept PER WORLD, so a trip back to the shared world returns you where you
// left it rather than to the default spawn — and never disturbs your own world's position.
test('the lobby records position per-world without clobbering another world', async (t) => {
  const dataDir = tmpDataDir();
  const solo = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: 'private' });
  const a = await TestClient.connect(solo.port);
  const { welcome } = await a.joinAsNew('Wanderer');
  const charId = String(welcome['characterId']);
  await a.waitEvent('PlayerList');
  a.sendEvent('PlayerAppearance', {
    race: 'dark elf', head: 'h', hair: 'x', isMale: true, class: 'nightblade', name: 'Wanderer',
  });
  a.sendEvent('ChargenComplete', {});
  a.sendEvent('PlayerInventory', { items: [{ id: 'gold_001', n: 7 }] });
  a.sendCellChange('solo,cell', 11, 22, 33);
  await a.waitEvent('PlayerCellChange');
  a.close();
  await a.closed;
  await solo.flush();
  await solo.close();
  const soloPositions = readPlayerDoc(dataDir, charId)?.['positions'] as Record<string, unknown>;
  const soloWorldId = Object.keys(soloPositions)[0]!;

  process.env.OMW_WORLD_ID = 'vvardenfell';
  t.after(() => { delete process.env.OMW_WORLD_ID; });
  const lobby = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: 'public' });
  t.after(() => lobby.close());
  const b = await TestClient.connect(lobby.port);
  b.hello();
  await b.waitJson('SessionHelloOk');
  b.login('Wanderer', 'hunter22');
  await b.waitJson('SessionWelcome');
  b.sendJson({ t: 'SessionReady' });
  await b.waitEvent('PlayerList');
  // Plausible, not absurd: MAX_COUNT is 10000 and the old 999999 was rejected outright by
  // the validator — invisible while the test expected the write to be dropped anyway.
  b.sendEvent('PlayerInventory', { items: [{ id: 'gold_001', n: 9000 }] });
  b.sendCellChange('lobby,cell', 44, 55, 66);
  await b.waitEvent('PlayerCellChange');
  b.close();
  await b.closed;
  await lobby.flush();

  const doc = readPlayerDoc(dataDir, charId);
  const positions = doc?.['positions'] as Record<string, { cellKey: string; x: number }>;
  assert.equal(positions['vvardenfell']?.cellKey, 'lobby,cell',
    'the lobby did not remember where the player stood');
  assert.equal(positions['vvardenfell']?.x, 44);
  assert.equal(positions[soloWorldId]?.cellKey, 'solo,cell',
    'the lobby clobbered the solo world position');
  assert.deepEqual(doc?.['inventory'], [{ id: 'gold_001', n: 9000 }],
    'the shared world must record what the character is carrying, losses included');
});
