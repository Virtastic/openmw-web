// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// A GUEST WORLD WITH NO HOST CLOSES — after a grace.
//
// A host who crashes or reloads should come back to their guests, not to an empty world: the
// guests keep playing through the grace window, and the world closes only if the owner does
// not return before it expires.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';
import { SocialStore } from '../src/core/socialstore';

test('the owner leaving closes the world to its guests', async (t) => {
  const dataDir = tmpDataDir();
  // mayJoinWorld admits the OWNER'S FRIENDS — so the fixture needs real friendships.
  // Written before the server opens the store.
  const social = new SocialStore(dataDir);
  social.addFriend('host', 'guest', Date.now());
  social.addFriend('host', 'tourist', Date.now());
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    worldMode: 'party', worldOwner: 'host', ownerGraceMs: 700,
    configOverride: { login: { allowHarnessAuth: true } } as never,
  });
  t.after(() => server.close());

  const owner = await TestClient.connect(server.port);
  await owner.joinAsNew('Host', 'hunter22');
  await owner.waitEvent('PlayerList');

  const guest = await TestClient.connect(server.port);
  t.after(() => guest.close());
  await guest.joinAsNew('Guest', 'hunter22');
  await guest.waitEvent('PlayerList');

  // The host closes their tab. The world does NOT close immediately — the guest plays on
  // through the grace window — and then closes when the host does not return.
  owner.close();
  await owner.closed;

  const early = await Promise.race([
    guest.waitEvent('WorldClosed', () => true, 300).then(() => 'closed', () => 'open'),
    new Promise((r) => setTimeout(() => r('open'), 400)),
  ]);
  assert.equal(early, 'open', 'the world closed inside the grace window');

  const closed = await guest.waitEvent('WorldClosed', () => true, 8000);
  assert.equal((closed.value as { reason?: string }).reason, 'owner_left',
    'the guest was never told the world lost its host');
});

test('the owner returning inside the grace keeps the world open', async (t) => {
  const dataDir = tmpDataDir();
  const social = new SocialStore(dataDir);
  social.addFriend('host', 'guest', Date.now());
  social.close();
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    worldMode: 'party', worldOwner: 'host', ownerGraceMs: 900,
    configOverride: { login: { allowHarnessAuth: true } } as never,
  });
  t.after(() => server.close());

  const owner = await TestClient.connect(server.port);
  await owner.joinAsNew('Host', 'hunter22');
  await owner.waitEvent('PlayerList');
  const guest = await TestClient.connect(server.port);
  t.after(() => guest.close());
  await guest.joinAsNew('Guest', 'hunter22');
  await guest.waitEvent('PlayerList');

  owner.close();
  await owner.closed;

  // The host comes back before the grace expires.
  const back = await TestClient.connect(server.port);
  t.after(() => back.close());
  await back.joinExisting('Host', 'hunter22');

  const got = await Promise.race([
    guest.waitEvent('WorldClosed', () => true, 1500).then(() => 'closed', () => 'open'),
    new Promise((r) => setTimeout(() => r('open'), 1800)),
  ]);
  assert.equal(got, 'open', 'the world closed even though the host returned in time');
});

test('a guest leaving closes nothing', async (t) => {
  const dataDir = tmpDataDir();
  // mayJoinWorld admits the OWNER'S FRIENDS.
  const social = new SocialStore(dataDir);
  social.addFriend('host', 'guest', Date.now());
  social.addFriend('host', 'tourist', Date.now());
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    worldMode: 'party', worldOwner: 'host',
    configOverride: { login: { allowHarnessAuth: true } } as never,
  });
  t.after(() => server.close());

  const owner = await TestClient.connect(server.port);
  t.after(() => owner.close());
  await owner.joinAsNew('Host', 'hunter22');
  await owner.waitEvent('PlayerList');

  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Tourist', 'hunter22');
  await a.waitEvent('PlayerList');
  a.close();
  await a.closed;

  // The host is still here, so the world stays open.
  const got = await Promise.race([
    // A timeout REJECTS, which would reject the race rather than meaning "nothing came".
    owner.waitEvent('WorldClosed', () => true, 1500).then(() => 'closed', () => 'open'),
    new Promise((r) => setTimeout(() => r('open'), 1800)),
  ]);
  assert.equal(got, 'open', 'a guest leaving closed the host out of their own world');
});
