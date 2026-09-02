// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// World access control: valid credentials are identity, not invitation. A private world
// admits only its owner (and admins); a party world admits the owner's FRIENDS up to the
// cap — the friends list is the only door. Checked at auth in the world itself — the
// directory's listing filter is visibility, never authorization.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { SocialStore } from '../src/core/socialstore';
import { TestClient, tmpDataDir } from './helpers';

test('private world: owner in, stranger refused; party world: friends in', async (t) => {
  const shared = tmpDataDir();

  // Accounts are created once on a standalone world sharing the dir.
  const pub = await startServer({ requireGameData: false, dataDir: tmpDataDir(), sharedDir: shared, port: 0, host: '127.0.0.1' });
  t.after(() => pub.close());
  for (const name of ['Alice', 'Bob', 'Carol']) {
    const c = await TestClient.connect(pub.port);
    await c.joinAsNew(name);
    c.close();
  }
  await pub.flush();

  // Alice's private world.
  const priv = await startServer({ requireGameData: false,
    dataDir: tmpDataDir(), sharedDir: shared, port: 0, host: '127.0.0.1',
    worldId: 'alice-solo', worldMode: 'private', worldOwner: 'alice',
  });
  t.after(() => priv.close());

  const alice = await TestClient.connect(priv.port);
  await alice.joinExisting('Alice'); // owner: welcome
  alice.close();

  const bob = await TestClient.connect(priv.port);
  bob.hello();
  await bob.waitJson('SessionHelloOk');
  bob.login('Bob', 'hunter22');
  const refusal = await bob.waitDisconnect('AUTH_FAILED');
  assert.match(String(refusal['detail']), /private/i);

  // A party world: Bob is Alice's friend; Carol is not.
  const store = new SocialStore(shared);
  store.addFriend('alice', 'bob', Date.now());
  store.close();

  const partyWorld = await startServer({ requireGameData: false,
    dataDir: tmpDataDir(), sharedDir: shared, port: 0, host: '127.0.0.1',
    worldId: 'alice-solo2', worldMode: 'party', worldOwner: 'alice',
  });
  t.after(() => partyWorld.close());

  const bob2 = await TestClient.connect(partyWorld.port);
  await bob2.joinExisting('Bob'); // the owner's friend: welcome
  bob2.close();

  const carol = await TestClient.connect(partyWorld.port);
  carol.hello();
  await carol.waitJson('SessionHelloOk');
  carol.login('Carol', 'hunter22');
  await carol.waitDisconnect('AUTH_FAILED'); // not a friend of the owner
});
