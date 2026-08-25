// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The shared PUBLIC world is a social lobby, and NOTHING done there follows you home.
//
// This file used to assert the opposite for inventory — "the shared world must record what the
// character is actually carrying" — on the reasoning that a withheld write is a withheld LOSS:
// drop something in the lobby and it stayed on the lobby's ground while your doc still claimed
// you carried it, so going home granted it back. That reasoning was right about the mechanism
// and wrong about the consequence. It is only a duplicate if one of the copies can ESCAPE, and
// the justification given for safety at the time ("its cells reset by construction") was not
// true either: [cellReset] cells is empty by default, so nothing reset, quest items never
// deplete from a container, and N strangers could each take the same Dwemer Puzzle Box and keep
// it on a real character forever.
//
// So the lobby now persists nothing at all (PlayerStore lobby mode) and the asymmetry stops
// mattering: you arrive with your gear, play, and leave with exactly what you had, in both
// directions. Quests and standing were already routed to nobody here (journalTarget).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir, readPlayerDoc } from './helpers';
import { PlayerStore } from '../src/persist/playerstore';

test('the shared world keeps nothing: not loot, not quests, not standing', async (t) => {
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
  // The 25 gold they "picked up" in the lobby is not theirs; the 10 they walked in with is.
  assert.deepEqual(after?.['inventory'], [{ id: 'gold_001', n: 10 }],
    'loot taken in the lobby followed the player home');
  // ...but nothing that amounts to campaign progress.
  assert.equal(after?.['factions'], undefined, 'a guild rank earned in the shared world followed the player home');
  assert.equal(after?.['bounty'], undefined, 'a bounty earned in the shared world followed the player home');
});

// Position is kept PER WORLD everywhere it is kept at all — and the lobby is not one of those
// places. What must never happen is the lobby reaching into a world where position IS real.
test('the lobby records no position, and never clobbers a world that does', async (t) => {
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
  // WHERE YOU STOOD IN THE LOBBY IS NOT REMEMBERED EITHER — "nothing persists" is not a rule
  // with exceptions, and position is simply not worth carving one out for. Returning players
  // are placed by materializePosition's cross-world fallback, which is what already stops the
  // real bug here: a player with no entry for this world used to have their position DELETED
  // and be dropped at exterior 0,0, the grid origin, open sea, where they drowned.
  assert.equal(positions['vvardenfell'], undefined, 'the lobby wrote a position it should not have');
  assert.equal(positions[soloWorldId]?.cellKey, 'solo,cell',
    'and it must not have disturbed the world where position IS real');
  assert.deepEqual(doc?.['inventory'], [{ id: 'gold_001', n: 7 }],
    'the 9000 gold declared in the lobby escaped it');
});

// SPAWNING AT THE ORIGIN. A player switching into a world they have never visited had their
// position DELETED — "no position at all" — which left the client on the engine's own default
// and dropped them at exterior cell 0,0, the grid origin, open sea. The live log is
// unambiguous: join_world -> cell_change "0,0" -> death. They are the same character walking
// into another instance of the same content, so a world with no entry of its own seeds from
// where they last stood.
test('a world you have never visited spawns you where you last were, not at the origin', async () => {
  const dir = tmpDataDir();
  const home = new PlayerStore(dir, 'priv-alice-abcd1234');
  home.update('c1', (d) => {
    d.positions = { 'priv-alice-abcd1234': { cellKey: 'seyda neen', x: 1, y: 2, z: 3 } };
  });
  await home.releaseCached('c1'); // flush + forget, the real cross-world path

  // The PUBLIC world has no entry for this character at all.
  const shared = new PlayerStore(dir, 'vvardenfell');
  const doc = await shared.get('c1');
  assert.ok(doc?.position, 'the player was given no position — the engine then picks 0,0');
  assert.equal(doc.position.cellKey, 'seyda neen');
  assert.equal(doc.position.x, 1);
});

// SWITCHING BACK AND FORTH KEEPS EACH WORLD'S OWN SPOT. This is the behaviour the per-world
// positions map exists for, and the seeding fix must not blur it: a world you HAVE visited
// always wins over "where you last stood somewhere else".
test('each world remembers its own position across repeated switches', async () => {
  const dir = tmpDataDir();

  const solo = new PlayerStore(dir, 'priv-alice-abcd1234');
  solo.update('c1', (d) => { d.position = { cellKey: 'seyda neen', x: 1, y: 1, z: 1 }; });
  await solo.releaseCached('c1');

  // First visit to the public world: seeded from where they were (not the ocean).
  const pub = new PlayerStore(dir, 'vvardenfell');
  assert.equal((await pub.get('c1'))?.position?.cellKey, 'seyda neen');
  pub.update('c1', (d) => { d.position = { cellKey: 'balmora', x: 9, y: 9, z: 9 }; });
  await pub.releaseCached('c1');

  // Back to solo: their SOLO spot, not balmora.
  const solo2 = new PlayerStore(dir, 'priv-alice-abcd1234');
  assert.deepEqual(
    { ...(await solo2.get('c1'))!.position, at: undefined },
    { cellKey: 'seyda neen', x: 1, y: 1, z: 1, at: undefined },
    'going home landed the player where they were in the PUBLIC world');
  await solo2.releaseCached('c1');

  // And back to public: balmora, the spot that world remembers.
  const pub2 = new PlayerStore(dir, 'vvardenfell');
  assert.equal((await pub2.get('c1'))?.position?.cellKey, 'balmora');
});
