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
import { TestClient, tmpDataDir, readPlayerDoc } from './helpers';

const APPEARANCE = { race: 'dark elf', head: 'h1', hair: 'a1', isMale: true, class: 'thief', name: 'Drelas' };

type WelcomeChar = { id: string; name: string; lastPlayedAt: string };

test('first auth creates a default character and reports it in Welcome', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const c = await TestClient.connect(server.port);
  const { welcome } = await c.joinAsNew('Alice');
  const chars = welcome['characters'] as WelcomeChar[];
  assert.equal(chars.length, 1);
  // NOT the account name. An SSO account name is the person's real name, and a character name
  // is public — it labels the tile and rides every PlayerAppearance to other players. The
  // auto-created slot therefore gets a neutral placeholder and is named for real by chargen.
  assert.equal(chars[0]!.name, 'Adventurer');
  assert.notEqual(chars[0]!.name, 'Alice');
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


test('explicit characterId: own character is honored, foreign/unknown is refused', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
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
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
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


// Regression: a player who FINISHED creation (race/class/sign chosen, appearance sent) but
// whose ChargenComplete flag never reached the server must not lose the character. An earlier
// revision inferred "abandoned creation" from "still in a chargen cell with no journal" and
// ERASED the doc — one missed signal deleted a real character and dropped the player back at
// the name prompt. Player state is never destroyed on load; the completion flag self-heals.
test('finished chargen without the completion flag survives a relog — never erased', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const c = await TestClient.connect(server.port);
  c.hello();
  await c.waitJson('SessionHelloOk');
  c.register('Nerevar', 'hunter22');
  await c.waitJson('SessionWelcome');
  c.sendJson({ t: 'SessionReady' });
  await c.waitEvent('PlayerList');
  // Creation finished: appearance exists. Still standing in a chargen cell with no journal
  // entry, and no ChargenComplete was delivered — exactly the state that used to be wiped.
  c.sendEvent('PlayerAppearance', {
    race: 'dark elf', head: 'b_n_dark elf_m_head_01', hair: 'b_n_dark elf_m_hair_02',
    isMale: true, class: 'nightblade', name: 'Nerevar',
  });
  await c.waitEvent('PlayerAppearance');
  c.sendCellChange('Imperial Prison Ship', 5, 6, 7);
  await c.waitEvent('PlayerCellChange');
  c.close(); // the refresh / random quit
  await new Promise((r) => setTimeout(r, 150)); // let the logout flush land

  const c2 = await TestClient.connect(server.port);
  c2.hello();
  await c2.waitJson('SessionHelloOk');
  c2.login('Nerevar', 'hunter22');
  const w = await c2.waitJson('SessionWelcome');
  const rec = w['playerRecord'] as
    { appearance?: { name: string }; position?: { cellKey: string; x: number } } | null;
  assert.notEqual(rec, null, 'the character was erased — the player restarts creation');
  assert.equal(rec?.appearance?.name, 'Nerevar');
  assert.equal(rec?.position?.cellKey, 'Imperial Prison Ship');
  assert.equal(rec?.position?.x, 5);
  c2.close();
});
