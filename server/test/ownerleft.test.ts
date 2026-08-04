// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// A GUEST WORLD WITH NO HOST IS NOBODY'S WORLD.
//
// Flipping to Solo already closed a party world to its guests. Nothing watched for the owner
// simply LEAVING — closing the tab, losing the connection — so the party was left standing in
// a world that no longer had a host, still believing it was in a party, in a place that would
// never come back. Everyone goes home and the party is disbanded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';
import { SocialStore } from '../src/core/socialstore';

test('the owner leaving closes the world to its guests', async (t) => {
  const dataDir = tmpDataDir();
  // mayJoinWorld admits the OWNER'S PARTY, resolved from live membership — so the fixture
  // needs a real party, not a bypass. Written before the server opens the store.
  const social = new SocialStore(dataDir);
  social.partyCreate('p1', 'host', Date.now());
  social.partyAddMember('p1', 'guest', Date.now());
  social.partyAddMember('p1', 'tourist', Date.now());
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    worldMode: 'party', worldOwner: 'host',
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

  // The host closes their tab.
  owner.close();
  await owner.closed;

  const closed = await guest.waitEvent('WorldClosed', () => true, 8000);
  assert.equal((closed.value as { reason?: string }).reason, 'owner_left',
    'the guest was never told the world lost its host');
});

test('a guest leaving closes nothing', async (t) => {
  const dataDir = tmpDataDir();
  // mayJoinWorld admits the OWNER'S PARTY, resolved from live membership — so the fixture
  // needs a real party, not a bypass. Written before the server opens the store.
  const social = new SocialStore(dataDir);
  social.partyCreate('p1', 'host', Date.now());
  social.partyAddMember('p1', 'guest', Date.now());
  social.partyAddMember('p1', 'tourist', Date.now());
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
