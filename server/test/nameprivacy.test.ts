// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// account.name is the LOGIN IDENTIFIER; for an SSO account it is the provider's name claim,
// i.e. the person's real name. account.username is the public handle (accounts.ts: "shown
// everywhere in-game"). Every social surface — party rows, friend rows, world-transition
// notices — names accounts through ONE resolver (Social deps.displayName, wired in
// server.ts), so a regression there puts real names on all of them at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

test('social payloads name a player by username, never by the account login name', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Ada Lovelace');
  await a.waitEvent('PlayerList');
  const b = await TestClient.connect(server.port);
  await b.joinAsNew('Alan Turing');
  await b.waitEvent('PlayerList');

  // Set the public handle over the wire, exactly as onboarding does.
  a.sendJson({ t: 'ProfileSetup', email: 'a@example.com', username: 'ada' });
  await a.waitJson('ProfileResult');
  b.sendJson({ t: 'ProfileSetup', email: 'b@example.com', username: 'turing' });
  await b.waitJson('ProfileResult');

  // A friend request names the OTHER account back to the requester: the resolver's surface.
  a.sendEvent('FriendRequest', { name: 'turing' });
  const res = await a.waitEvent('SocialResult',
    (v) => (v as { op?: string }).op === 'FriendRequest', 8000);
  assert.equal((res.value as { ok?: boolean }).ok, true,
    'the username must resolve to an account — players type what they SEE');

  b.sendEvent('FriendAccept', { acct: 'ada lovelace' });
  // Not the empty FriendList sent at join — the one carrying the new friend.
  const list = await b.waitEvent('FriendList',
    (v) => ((v as { friends?: unknown[] }).friends?.length ?? 0) > 0, 8000);
  const wire = JSON.stringify(list.value);
  assert.ok(wire.length > 20, 'empty payload — this assertion would prove nothing');
  assert.ok(wire.includes('ada'), 'the friend row must carry the username, got: ' + wire);
  assert.ok(!wire.includes('Ada Lovelace'),
    'the account login name reached a peer-visible payload: ' + wire);
  a.close();
  b.close();
});

// The same invariant ACROSS WORLDS, which is where it actually broke. Every world is its own
// process with its own AccountStore cache, so the resolver's first lookup (cachedByKey) knows
// only the accounts THIS world has touched. A friend playing their own game was never touched
// here — and the fallback for "no display name" is the account key, i.e. the real name the
// test above exists to keep off the wire. Two servers on one shared dir is exactly the
// gateway's layout, and the second one has never seen Ada.
test('a name resolved in a world that never met the account is still the username', async (t) => {
  const shared = tmpDataDir();
  const worldA = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), sharedDir: shared, port: 0, host: '127.0.0.1',
  });
  t.after(() => worldA.close());
  const worldB = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), sharedDir: shared, port: 0, host: '127.0.0.1',
  });
  t.after(() => worldB.close());

  // Both become friends in world A, handles and all.
  const a = await TestClient.connect(worldA.port);
  await a.joinAsNew('Ada Lovelace');
  await a.waitEvent('PlayerList');
  const b = await TestClient.connect(worldA.port);
  await b.joinAsNew('Alan Turing');
  await b.waitEvent('PlayerList');
  a.sendJson({ t: 'ProfileSetup', email: 'a@example.com', username: 'ada' });
  await a.waitJson('ProfileResult');
  b.sendJson({ t: 'ProfileSetup', email: 'b@example.com', username: 'turing' });
  await b.waitJson('ProfileResult');
  a.sendEvent('FriendRequest', { name: 'turing' });
  await a.waitEvent('SocialResult', (v) => (v as { op?: string }).op === 'FriendRequest', 8000);
  b.sendEvent('FriendAccept', { acct: 'ada lovelace' });
  await b.waitEvent('FriendList', (v) => ((v as { friends?: unknown[] }).friends?.length ?? 0) > 0, 8000);
  a.close();
  b.close();

  // Alan opens his own game. World B has never loaded Ada's account — only the shared
  // usernames table can say what she is called.
  const b2 = await TestClient.connect(worldB.port);
  await b2.joinExisting('Alan Turing');
  const list = await b2.waitEvent('FriendList',
    (v) => ((v as { friends?: unknown[] }).friends?.length ?? 0) > 0, 8000);
  const wire = JSON.stringify(list.value);
  assert.ok(wire.includes('"acct":"ada lovelace"'),
    'wrong row — this assertion would prove nothing: ' + wire);
  assert.ok(!wire.includes('Ada Lovelace'),
    'a world that never met the account named her by her login name: ' + wire);
  assert.ok(!wire.includes('"name":"ada lovelace"'),
    'the friend row fell back to the account key instead of the handle: ' + wire);
  assert.ok(wire.includes('"name":"ada"'), 'the friend row must carry the handle: ' + wire);
  b2.close();
});
