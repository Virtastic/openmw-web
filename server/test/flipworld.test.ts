// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Flip-in-place: a character's Solo world becomes their Party world WITHOUT respawning it or
// moving the owner — the owner flips it and it starts admitting their friends. Only the
// owner (or an admin) may flip.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { SocialStore } from '../src/core/socialstore';
import { TestClient, tmpDataDir } from './helpers';

test('owner flips private->party in place; their friend is then admitted; a guest cannot flip', async (t) => {
  const shared = tmpDataDir();
  const pub = await startServer({ requireGameData: false, dataDir: tmpDataDir(), sharedDir: shared, port: 0, host: '127.0.0.1' });
  t.after(() => pub.close());
  for (const name of ['Alice', 'Bob']) {
    const c = await TestClient.connect(pub.port);
    await c.joinAsNew(name);
    c.close();
  }
  await pub.flush();

  // Bob is Alice's friend — the same store the world consults for "who may join".
  const store = new SocialStore(shared);
  store.addFriend('alice', 'bob', Date.now());
  store.close();

  // Alice's PRIVATE world (her solo instance). Owner = alice.
  const world = await startServer({ requireGameData: false,
    dataDir: tmpDataDir(), sharedDir: shared, port: 0, host: '127.0.0.1',
    worldId: 'priv-alice', worldMode: 'private', worldOwner: 'alice',
  });
  t.after(() => world.close());

  const alice = await TestClient.connect(world.port);
  await alice.joinExisting('Alice'); // owner: welcome

  // While private, Bob (a friend) is still refused — private is solo.
  const bob1 = await TestClient.connect(world.port);
  bob1.hello();
  await bob1.waitJson('SessionHelloOk');
  bob1.login('Bob', 'hunter22');
  const refusal = await bob1.waitDisconnect('AUTH_FAILED');
  assert.match(String(refusal['detail']), /private/i);

  // Alice flips HER world to party — in place, she does not move.
  alice.sendEvent('SetWorldMode', { mode: 'party' });
  await alice.waitEvent('SocialResult',
    (v) => (v as { op?: string; ok?: boolean }).op === 'SetWorldMode' && (v as { ok?: boolean }).ok === true);

  // Now Bob is admitted to Alice's (formerly private) world.
  const bob2 = await TestClient.connect(world.port);
  await bob2.joinExisting('Bob');

  // A non-owner guest cannot flip the world.
  bob2.sendEvent('SetWorldMode', { mode: 'private' });
  const denied = await bob2.waitEvent('SocialResult', (v) => (v as { op?: string }).op === 'SetWorldMode');
  assert.equal((denied.value as { ok?: boolean }).ok, false);
  assert.equal((denied.value as { detail?: string }).detail, 'not_owner');

  bob2.close();
  alice.close();
});

test('a world you do not own is not flippable', async (t) => {
  // A standalone world has no owner, so no ordinary player may flip it.
  const pub = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1' });
  t.after(() => pub.close());
  const c = await TestClient.connect(pub.port);
  await c.joinAsNew('Zoe');
  c.sendEvent('SetWorldMode', { mode: 'party' });
  const r = await c.waitEvent('SocialResult', (v) => (v as { op?: string }).op === 'SetWorldMode');
  assert.equal((r.value as { ok?: boolean }).ok, false);
  assert.equal((r.value as { detail?: string }).detail, 'not_owner');
  c.close();
});

// Closing your world means closing it. mayJoinWorld only gates ARRIVAL, so flipping back to
// Solo used to leave every guest standing inside a world that had just stopped admitting
// them.
test('flipping back to Solo evicts the guests who are already inside', async (t) => {
  const shared = tmpDataDir();
  const pub = await startServer({ requireGameData: false, dataDir: tmpDataDir(), sharedDir: shared, port: 0, host: '127.0.0.1' });
  t.after(() => pub.close());
  for (const name of ['Ada', 'Ben']) {
    const c = await TestClient.connect(pub.port);
    await c.joinAsNew(name);
    c.close();
  }
  await pub.flush();

  const store = new SocialStore(shared);
  store.addFriend('ada', 'ben', Date.now());
  store.close();

  const world = await startServer({ requireGameData: false,
    dataDir: tmpDataDir(), sharedDir: shared, port: 0, host: '127.0.0.1',
    worldId: 'priv-ada', worldMode: 'party', worldOwner: 'ada',
  });
  t.after(() => world.close());

  const ada = await TestClient.connect(world.port);
  await ada.joinExisting('Ada');
  const ben = await TestClient.connect(world.port);
  await ben.joinExisting('Ben');

  ada.sendEvent('SetWorldMode', { mode: 'private' });
  await ada.waitEvent('SocialResult',
    (v) => (v as { op?: string; ok?: boolean }).op === 'SetWorldMode' && (v as { ok?: boolean }).ok === true);

  // The guest is told to go home. The owner is not.
  const closed = await ben.waitEvent('WorldClosed', () => true, 5000);
  assert.equal((closed.value as { reason?: string }).reason, 'owner_went_solo');

  ben.close();
  ada.close();
});
