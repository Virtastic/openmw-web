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
// The whole-world ceiling (one peer simulates every occupied cell, so it is a memory
// decision) used to live inside mayJoinWorld — a function that answers "may this account be
// here", not "is there room". So the owner's 33rd friend was refused with "this world is
// private": untrue, unfalsifiable from the player's side (it reads as the host going solo or
// blocking them), and invisible to the host, who sees a working world and no error. Worse,
// /status advertised [server].maxPlayers — 64 by default — so the number shown to everyone
// was one nobody enforced, and the 32..64 window was pure misinformation.
//
// The ceiling is applied to the configured cap at boot instead, so the advertised seats, the
// SERVER_FULL refusal and the admission check are the same number and that window is gone.
test('the advertised player cap is the one actually enforced', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { maxPlayers: 64 } },
  });
  t.after(() => server.close());

  const status = await (await fetch(`http://127.0.0.1:${server.port}/status`)).json() as
    { maxPlayers: number };
  assert.ok(status.maxPlayers <= 32,
    `advertised ${status.maxPlayers} seats, but a world admits at most 32 — the gap is where`
    + ' a full world used to refuse friends with "this world is private"');
  assert.equal(status.maxPlayers, 32, 'the configured 64 must be clamped to the world ceiling');
});
