// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Character slots: default character creation at first auth, legacy account-keyed doc
// migration, explicit characterId selection (and its refusal), per-world positions in a
// shared character doc, resume returning to the same character.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PlayerStore } from '../src/persist/playerstore';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const APPEARANCE = { race: 'dark elf', head: 'h1', hair: 'a1', isMale: true, class: 'thief', name: 'Drelas' };

type WelcomeChar = { id: string; name: string; lastPlayedAt: string };

test('first auth creates a default character and reports it in Welcome', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const c = await TestClient.connect(server.port);
  const { welcome } = await c.joinAsNew('Alice');
  const chars = welcome['characters'] as WelcomeChar[];
  assert.equal(chars.length, 1);
  assert.equal(chars[0]!.name, 'Alice');
  assert.match(chars[0]!.id, /^c[0-9a-f]{24}$/);
  assert.equal(welcome['characterId'], chars[0]!.id);
  c.close();

  // Second login: same character comes back, no second slot is invented.
  const c2 = await TestClient.connect(server.port);
  const w2 = await c2.joinExisting('Alice');
  const chars2 = w2['characters'] as WelcomeChar[];
  assert.equal(chars2.length, 1);
  assert.equal(chars2[0]!.id, chars[0]!.id);
  c2.close();
});

test('pre-slot account: legacy account-keyed doc is adopted by the first character', async (t) => {
  const dataDir = tmpDataDir();
  // A pre-slot world left players/alice.json keyed by account name.
  const playersDir = join(dataDir, 'players');
  mkdirSync(playersDir, { recursive: true });
  writeFileSync(join(playersDir, 'alice.json'), JSON.stringify({
    appearance: APPEARANCE,
    inventory: [{ id: 'gold_001', n: 77 }],
    position: { cellKey: '3,-2', x: 1, y: 2, z: 3 },
  }));

  const server = await startServer({ dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const c = await TestClient.connect(server.port);
  const { welcome } = await c.joinAsNew('Alice');
  const chars = welcome['characters'] as WelcomeChar[];
  assert.equal(chars.length, 1);
  // The migrated doc IS the player record: appearance survives, so no fresh chargen.
  const record = welcome['playerRecord'] as { appearance?: typeof APPEARANCE; inventory?: unknown };
  assert.deepEqual(record?.appearance, APPEARANCE);
  assert.deepEqual(record?.inventory, [{ id: 'gold_001', n: 77 }]);
  // And the doc now lives under the character id.
  assert.ok(existsSync(join(playersDir, `${chars[0]!.id}.json`)));
  c.close();
});

test('explicit characterId: own character is honored, foreign/unknown is refused', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const c = await TestClient.connect(server.port);
  const { welcome } = await c.joinAsNew('Alice');
  const charId = welcome['characterId'] as string;
  c.close();

  // Reconnect selecting the character explicitly.
  const c2 = await TestClient.connect(server.port);
  c2.hello();
  await c2.waitJson('SessionHelloOk');
  c2.login('Alice', 'hunter22', { characterId: charId });
  const w2 = await c2.waitJson('SessionWelcome');
  assert.equal(w2['characterId'], charId);
  c2.close();

  // An id the account does not own is an auth failure, never a silent default.
  const c3 = await TestClient.connect(server.port);
  c3.hello();
  await c3.waitJson('SessionHelloOk');
  c3.login('Alice', 'hunter22', { characterId: 'c000000000000000000000ff' });
  await c3.waitDisconnect('AUTH_FAILED');
});

test('CharacterCreate: adds a slot, enforces name rules and the cap; new slot is playable', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const c = await TestClient.connect(server.port);
  c.hello();
  await c.waitJson('SessionHelloOk');
  c.register('Alice', 'hunter22');
  await c.waitJson('SessionWelcome'); // AUTHED (no Ready yet — the select screen state)

  c.sendJson({ t: 'CharacterCreate', name: '!' });
  let r = await c.waitJson('CharacterResult');
  assert.deepEqual([r['ok'], r['error']], [false, 'badname']);

  c.sendJson({ t: 'CharacterCreate', name: 'Drelas Arano' });
  r = await c.waitJson('CharacterResult');
  assert.equal(r['ok'], true);
  const chars = r['characters'] as WelcomeChar[];
  assert.equal(chars.length, 2);
  const drelas = chars.find((x) => x.name === 'Drelas Arano')!;
  c.close();

  // The new slot is selectable and starts fresh (no playerRecord → chargen).
  const c2 = await TestClient.connect(server.port);
  c2.hello();
  await c2.waitJson('SessionHelloOk');
  c2.login('Alice', 'hunter22', { characterId: drelas.id });
  const w2 = await c2.waitJson('SessionWelcome');
  assert.equal(w2['characterId'], drelas.id);
  assert.equal(w2['playerRecord'], null);
  c2.close();

  // Cap: fill the remaining slots, then one more is refused.
  const c3 = await TestClient.connect(server.port);
  c3.hello();
  await c3.waitJson('SessionHelloOk');
  c3.login('Alice', 'hunter22');
  await c3.waitJson('SessionWelcome');
  for (let i = 3; i <= 8; i++) {
    c3.sendJson({ t: 'CharacterCreate', name: `Alt ${i}` });
    const ri = await c3.waitJson('CharacterResult');
    assert.equal(ri['ok'], true, `slot ${i} should fit`);
  }
  c3.sendJson({ t: 'CharacterCreate', name: 'One Too Many' });
  const rf = await c3.waitJson('CharacterResult');
  assert.deepEqual([rf['ok'], rf['error']], [false, 'full']);
  c3.close();
});

test('shared character doc keeps per-world positions apart', async () => {
  const dataDir = tmpDataDir();
  const charId = 'c00112233445566778899aabb';

  const w1 = new PlayerStore(dataDir, 'world-a');
  w1.update(charId, (doc) => {
    doc.stats = { level: 5 };
    doc.position = { cellKey: '1,1', x: 10, y: 20, z: 30 };
  });
  await w1.close();

  // Another world sees the character (stats) but NOT world-a's position.
  const w2 = new PlayerStore(dataDir, 'world-b');
  const seenByB = await w2.get(charId);
  assert.equal(seenByB?.stats?.level, 5);
  assert.equal(seenByB?.position, undefined);
  w2.update(charId, (doc) => (doc.position = { cellKey: '9,9', x: 1, y: 1, z: 1 }));
  await w2.close();

  // world-a still has its own position; world-b's write did not clobber it.
  const w1again = new PlayerStore(dataDir, 'world-a');
  const seenByA = await w1again.get(charId);
  assert.deepEqual(seenByA?.position, { cellKey: '1,1', x: 10, y: 20, z: 30 });
  await w1again.close();

  const w2again = new PlayerStore(dataDir, 'world-b');
  const seenByB2 = await w2again.get(charId);
  assert.deepEqual(seenByB2?.position, { cellKey: '9,9', x: 1, y: 1, z: 1 });
  await w2again.close();
});

test('adoptLegacy: migrates once, scopes the legacy position to this world', async () => {
  const dataDir = tmpDataDir();
  const legacyDir = join(dataDir, 'world1', 'players');
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, 'bob.json'), JSON.stringify({
    appearance: APPEARANCE,
    position: { cellKey: '2,2', x: 5, y: 5, z: 5 },
  }));

  const shared = join(dataDir, 'shared');
  const store = new PlayerStore(shared, 'world1', legacyDir);
  const adopted = await store.adoptLegacy('bob', 'caabbccddeeff00112233445');
  assert.deepEqual(adopted?.appearance, APPEARANCE);
  assert.deepEqual(adopted?.position, { cellKey: '2,2', x: 5, y: 5, z: 5 });
  await store.close();

  // From another world the same character has no position (it was world1's).
  const other = new PlayerStore(shared, 'world2');
  const doc = await other.get('caabbccddeeff00112233445');
  assert.deepEqual(doc?.appearance, APPEARANCE);
  assert.equal(doc?.position, undefined);
  await other.close();

  // Adopting again (crash between doc write and account flush) is a no-op, not a reset.
  const again = new PlayerStore(shared, 'world1', legacyDir);
  const re = await again.adoptLegacy('bob', 'caabbccddeeff00112233445');
  assert.deepEqual(re?.appearance, APPEARANCE);
  await again.close();
});
