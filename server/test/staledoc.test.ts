// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// A WORLD MUST NOT REMEMBER A CHARACTER IT IS NOT HOLDING.
//
// get() answers from the cache and never re-reads disk; flushKey writes the WHOLE doc with
// INSERT OR REPLACE. Nothing dropped the cache on logout, so a long-lived world — the shared
// one never restarts — kept a snapshot from the player's last visit for as long as it stayed
// up. Play somewhere else for an hour, come back, and its next flush replaced that hour with
// the stale copy. Silent, and it destroyed real progress.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerStore } from '../src/persist/playerstore';
import { startServer } from '../src/server';
import { TestClient } from './helpers';
import { AccountStore } from '../src/core/accounts';
import { tmpDataDir } from './helpers';

test('a world re-reads a character it let go, instead of trusting its own copy', async () => {
  const dir = tmpDataDir();
  const key = 'c-hero';

  // World A holds the character, writes, and lets it go.
  const worldA = new PlayerStore(dir, 'world-a');
  worldA.update(key, (d) => { d.inventory = [{ id: 'gold_001', n: 10 }]; });
  await worldA.flushAll();
  await worldA.releaseCached(key);

  // The player spends an hour somewhere else. Same shared players.db, different process.
  const worldB = new PlayerStore(dir, 'world-b');
  assert.deepEqual((await worldB.get(key))?.inventory, [{ id: 'gold_001', n: 10 }]);
  worldB.update(key, (d) => { d.inventory = [{ id: 'gold_001', n: 5000 }]; });
  await worldB.flushAll();

  // ...and comes back to A, which is still the same running process.
  const back = await worldA.get(key);
  assert.deepEqual(back?.inventory, [{ id: 'gold_001', n: 5000 }],
    'world A answered from a stale cache — the hour spent elsewhere is about to be overwritten');

  // The killer was the write-back, not just the read: A flushes the whole doc.
  worldA.update(key, (d) => { d.position = { cellKey: '0,0', x: 1, y: 2, z: 3 }; });
  await worldA.flushAll();
  const onDisk = new PlayerStore(dir, 'world-c');
  assert.deepEqual((await onDisk.get(key))?.inventory, [{ id: 'gold_001', n: 5000 }],
    'world A wrote its stale copy back over the newer one');
});

// A character created in-game kept the slot's placeholder label — "New character" — in the
// launcher and in the social panel, forever. onCharacterNamed writes the chargen name onto
// the slot, but it fires on PlayerAppearance, which arrives while the slot is still
// PROVISIONAL and unwritten, so the rename lands on nothing. By the time the slot is adopted
// the appearance has stopped changing, so the diff never re-sends and nothing corrects it.
test('a character is adopted under the name the player chose, not the placeholder', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: { login: { allowHarnessAuth: true } } as never,
  });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  const { welcome } = await a.joinAsNew('Namer', 'hunter22');
  const charId = String(welcome['characterId']);
  await a.waitEvent('PlayerList');

  // Chargen: the player picks a name, THEN creation finishes.
  a.sendEvent('PlayerAppearance', {
    race: 'dark elf', head: 'h', hair: 'x', isMale: true, class: 'nightblade', name: 'Ravenhand',
  });
  a.sendEvent('ChargenComplete', {});
  // The rename is a tracked promise (accounts.get -> nameCharacter); give it a turn.
  await new Promise((r) => setTimeout(r, 400));
  await server.flush();

  const accounts = new AccountStore(dataDir);
  const acct = await accounts.get('namer');
  const slot = acct?.characters?.find((c) => c.id === charId);
  assert.equal(slot?.name, 'Ravenhand',
    'the slot kept its placeholder label instead of the name the player chose');
});
