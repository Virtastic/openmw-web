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
    (v) => JSON.stringify(v).length > 30, 8000);
  const wire = JSON.stringify(list.value);
  assert.ok(wire.length > 20, 'empty payload — this assertion would prove nothing');
  assert.ok(wire.includes('ada'), 'the friend row must carry the username, got: ' + wire);
  assert.ok(!wire.includes('Ada Lovelace'),
    'the account login name reached a peer-visible payload: ' + wire);
  a.close();
  b.close();
});
