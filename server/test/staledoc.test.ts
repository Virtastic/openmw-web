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

// A CACHE MISS MUST NOT MEAN "NEW CHARACTER". update() fabricated an empty doc when the key
// was not cached, so any miss became a silent truncation: the stub takes one field and
// flushKey stores it with INSERT OR REPLACE, dropping inventory, stats, journal and
// appearance from the row. Misses are ordinary — a supersede tears down the previous session
// and drops the cache while the new one is live — so this destroyed characters on a reconnect.
test('a write against an uncached character does not truncate it', async () => {
  const dir = tmpDataDir();
  const key = 'c-hero';

  const first = new PlayerStore(dir, 'world-a');
  first.update(key, (d) => {
    d.inventory = [{ id: 'gold_001', n: 900 }];
    d.stats = { level: 14 } as never;
  });
  await first.flushAll();

  // A fresh store has nothing cached — the same state the eviction leaves behind.
  const cold = new PlayerStore(dir, 'world-a');
  cold.update(key, (d) => { d.position = { cellKey: '0,0', x: 1, y: 2, z: 3 }; }, 'now');
  await cold.flushAll();

  const after = await new PlayerStore(dir, 'world-a').get(key);
  assert.deepEqual(after?.inventory, [{ id: 'gold_001', n: 900 }],
    'writing one field against an uncached character wiped the rest of it');
  assert.equal((after?.stats as { level?: number } | undefined)?.level, 14);
  assert.equal(after?.position?.cellKey, '0,0', 'and the write itself must still land');
});

// THE SAME DISEASE, THIRD HOST. AccountStore.get returned its cache forever, and the gateway
// plus every world each hold one over the same accounts.db — so a long-running world
// authenticated players against the character list it saw at its own boot: characters created
// since didn't exist, completed flags were stale, and one player was routed into a DELETED
// character's still-running world with inChargen wrongly false, where the sim peer took the
// cell and froze the chargen guard. A clean cached doc must be re-read; queued writes win.
test('a world sees characters another process created after it first looked', async () => {
  const dir = tmpDataDir();
  const gateway = new AccountStore(dir);
  const world = new AccountStore(dir);

  const acct = await gateway.register('Traveller', 'hunter22');
  assert.ok(typeof acct !== 'string');
  await gateway.flush();

  // The world looks once — this is the first impression it used to keep forever.
  assert.equal((await world.get('traveller'))?.characters?.length ?? 0, 0);

  // The gateway then creates a slot (the launcher's "+ New character" tile).
  const fresh = await gateway.get('traveller');
  assert.ok(fresh);
  const created = gateway.createCharacter(fresh, 'Virtastic');
  assert.ok(typeof created !== 'string');
  await gateway.flush();

  // The world must see it — authing this character is what sets inChargen correctly.
  const seen = await world.get('traveller');
  assert.equal(seen?.characters?.length, 1,
    'the world authenticated against a character list from before the slot existed');
  assert.equal(seen?.characters?.[0]?.completed !== true, true);
});

// THE SAME DISEASE ON THE WRITE SIDE. The gateway and every world hold their own AccountStore
// over one accounts.db and each flushes the WHOLE document, so the last writer won outright:
// a process whose cached copy predated a character wiped that character off the account.
// Observed live as three player docs with real journals and an account with ZERO slots — a
// finished character that has to run chargen again, because the character screen cannot see it.
test('a stale process flushing does not wipe a character another process created', async () => {
  const dir = tmpDataDir();
  const gateway = new AccountStore(dir);
  const world = new AccountStore(dir);

  const acct = await gateway.register('Traveller', 'hunter22');
  assert.ok(typeof acct !== 'string');
  await gateway.flush();

  // The gateway holds the account and dirties it — this is what pinned its stale copy.
  const gwCopy = await gateway.get('traveller');
  assert.ok(gwCopy);
  gateway.touchLastSeen('Traveller'); // dirties the gateway's copy — what pinned the stale doc

  // Meanwhile the WORLD adopts a character (chargen finished) and flushes it.
  const wCopy = await world.get('traveller');
  assert.ok(wCopy);
  const made = world.createCharacter(wCopy, 'Virtastic');
  assert.ok(typeof made !== 'string');
  await world.flush();

  // Now the gateway flushes its copy, which never knew about that character.
  await gateway.flush();

  const after = new AccountStore(dir);
  const seen = await after.get('traveller');
  assert.equal(seen?.characters?.length, 1,
    'a stale flush erased a character that had already finished creation');
  assert.equal(seen?.characters?.[0]?.name, 'Virtastic');
});

// ...but a DELETED character must stay deleted, or the merge resurrects every slot the player
// ever removed as soon as any stale process flushes.
test('a deleted character is not resurrected by a stale flush', async () => {
  const dir = tmpDataDir();
  const a = new AccountStore(dir);
  const acct = await a.register('Traveller', 'hunter22');
  assert.ok(typeof acct !== 'string');
  const made = a.createCharacter(acct, 'Doomed');
  assert.ok(typeof made !== 'string');
  await a.flush();

  const b = new AccountStore(dir);
  const stale = await b.get('traveller'); // b's copy still has the character
  assert.equal(stale?.characters?.length, 1);

  const own = await a.get('traveller');
  assert.ok(own);
  assert.equal(a.deleteCharacter(own, made.id), true);
  await a.flush();

  await b.flush(); // stale process writes its copy, which still lists the deleted slot
  const after = new AccountStore(dir);
  assert.equal((await after.get('traveller'))?.characters?.length ?? 0, 0,
    'a deleted character came back');
});
