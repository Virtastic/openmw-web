// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Standing has to make the ROUND TRIP, and for a long time it only made half of it: faction
// rank/reputation/expulsion and crime bounty were written to the character doc and never read
// back by anything, so "your standing follows you" was true on the way out and false on the
// way in. The client now applies them from playerRecord (quests.restoreStanding).
//
// The server half asserted here is the other requirement: standing is routed like the journal,
// so a shared world — which resets, and persists no campaign progress — cannot hand out guild
// ranks or bounties that follow a visitor home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir, readPlayerDoc } from './helpers';

async function ownWorld(dataDir: string) {
  return startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: 'private',
    configOverride: { login: { allowHarnessAuth: true } } as never,
  });
}

test('standing earned in your own world is recorded and sent back on the next join', async (t) => {
  const dataDir = tmpDataDir();
  const solo = await ownWorld(dataDir);
  const a = await TestClient.connect(solo.port);
  const { welcome } = await a.joinAsNew('Ranker', 'hunter22');
  const charId = String(welcome['characterId']);
  await a.waitEvent('PlayerList');
  a.sendEvent('PlayerAppearance', {
    race: 'dark elf', head: 'h', hair: 'x', isMale: true, class: 'nightblade', name: 'Ranker',
  });
  a.sendEvent('ChargenComplete', {});
  a.sendEvent('FactionUpdate', { factionId: 'fightersguild', rank: 3, reputation: 12 });
  a.sendEvent('CrimeUpdate', { bounty: 250 });
  a.close();
  await a.closed;
  await solo.flush();
  await solo.close();

  const doc = readPlayerDoc(dataDir, charId);
  assert.deepEqual((doc?.['factions'] as Record<string, unknown>)?.['fightersguild'],
    { rank: 3, reputation: 12 }, 'the rank was not recorded');
  assert.equal(doc?.['bounty'], 250, 'the bounty was not recorded');

  // ...and comes back. playerRecord is the whole doc, which is what the client restores from.
  const solo2 = await ownWorld(dataDir);
  t.after(() => solo2.close());
  const b = await TestClient.connect(solo2.port);
  t.after(() => b.close());
  const w2 = await b.joinExisting('Ranker');
  const record = w2['playerRecord'] as Record<string, unknown> | null;
  assert.ok(record, 'no playerRecord: there is nothing for the client to restore from');
  assert.deepEqual((record?.['factions'] as Record<string, unknown>)?.['fightersguild'],
    { rank: 3, reputation: 12 }, 'standing was not sent back to the client');
  assert.equal(record?.['bounty'], 250);
});

test('the shared world hands out no standing that follows you home', async (t) => {
  const dataDir = tmpDataDir();
  const solo = await ownWorld(dataDir);
  const a = await TestClient.connect(solo.port);
  const { welcome } = await a.joinAsNew('Visitor', 'hunter22');
  const charId = String(welcome['characterId']);
  await a.waitEvent('PlayerList');
  a.sendEvent('PlayerAppearance', {
    race: 'dark elf', head: 'h', hair: 'x', isMale: true, class: 'nightblade', name: 'Visitor',
  });
  a.sendEvent('ChargenComplete', {});
  a.close();
  await a.closed;
  await solo.flush();
  await solo.close();

  process.env.OMW_WORLD_ID = 'vvardenfell';
  t.after(() => { delete process.env.OMW_WORLD_ID; });
  const lobby = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: 'public',
    configOverride: { login: { allowHarnessAuth: true } } as never,
  });
  t.after(() => lobby.close());
  const b = await TestClient.connect(lobby.port);
  t.after(() => b.close());
  await b.joinExisting('Visitor');
  await b.waitEvent('PlayerList');
  b.sendEvent('FactionUpdate', { factionId: 'thievesguild', rank: 8 });
  b.sendEvent('CrimeUpdate', { bounty: 9999 });
  b.close();
  await b.closed;
  await lobby.flush();

  const doc = readPlayerDoc(dataDir, charId);
  assert.equal(doc?.['factions'], undefined, 'the shared world ranked the visitor up for keeps');
  assert.equal(doc?.['bounty'], undefined, 'a shared-world bounty followed the visitor home');
});
