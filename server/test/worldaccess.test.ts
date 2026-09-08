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

// A FULL WORLD MUST NOT CLAIM TO BE A PRIVATE ONE.
//
// The ceiling used to live inside mayJoinWorld — a function that answers "may this account be
// here", not "is there room". So the owner's 33rd friend was refused with "this world is
// private": untrue, unfalsifiable from the player's side (it reads as the host going solo or
// blocking them), and invisible to the host, who sees a working world and no error.
//
// The capacity question belongs to the one place that can answer it out loud: the SERVER_FULL
// disconnect. And the number it answers with is the OPERATOR'S — [server] maxPlayers, the same
// one /status and the dashboard advertise. Advertised and enforced are the same number because
// they are literally the same field, not because one was clamped to the other.
test('the advertised player cap is the number the operator set, and the one enforced', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { maxPlayers: 64 } },
  });
  t.after(() => server.close());

  const status = await (await fetch(`http://127.0.0.1:${server.port}/status`)).json() as
    { maxPlayers: number };
  assert.equal(status.maxPlayers, 64,
    'the operator asked for 64 seats; advertising anything else means the number shown is not'
    + ' the number enforced, which is the gap a full world used to fill with "this world is private"');
});
