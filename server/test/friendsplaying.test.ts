// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// THE LAUNCHER'S "FRIENDS PLAYING NOW". A drop-in used to cost two full boots -- home, then the
// social panel, then a reload into the friend's world. GET /auth/friends-playing tells the
// launcher which friends have a world open to friends and occupied, so the first boot can go
// straight there. Friends only, blocks respected, private and empty worlds not listed, and the
// world named is the one the friend is IN (an owner on their second character has two up).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AccountStore } from '../src/core/accounts';
import { LockerSessionStore } from '../src/auth/identities';
import { SocialStore } from '../src/core/socialstore';
import { friendsPlayingRoutes } from '../src/gateway/frontdoor';
import { tmpDataDir } from './helpers';

test('friends-playing lists friends in an open or solo occupied world, and names the world they are in', async (t) => {
  const dir = tmpDataDir();
  const accounts = new AccountStore(dir);
  for (const n of ['Alice', 'Bob', 'Cara', 'Dan', 'Eve']) await accounts.createSso(n);
  await accounts.setUsername((await accounts.get('bob'))!, 'BobbyB');
  await accounts.flush();
  const social = new SocialStore(dir);
  const now = Date.now();
  social.addFriend('alice', 'bob', now);
  social.addFriend('alice', 'cara', now);
  social.addFriend('alice', 'dan', now);
  social.addFriend('alice', 'eve', now);
  social.addBlock('dan', 'alice', now); // Dan blocked Alice: not on her list, party or not
  const sessions = new LockerSessionStore();
  const worlds = [
    { id: 'priv-bob-old', ownerAccount: 'bob', mode: 'party', up: true, playerCount: 0 },
    { id: 'priv-bob-now', ownerAccount: 'bob', mode: 'party', up: true, playerCount: 2 },
    { id: 'priv-cara', ownerAccount: 'cara', mode: 'private', up: true, playerCount: 1 },
    { id: 'priv-dan', ownerAccount: 'dan', mode: 'party', up: true, playerCount: 1 },
    { id: 'priv-eve', ownerAccount: 'eve', mode: 'private', up: true, playerCount: 0 }, // idle: not playing
  ];
  const route = friendsPlayingRoutes(accounts, sessions, social, () => worlds);
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    void Promise.resolve(route(req, res, url)).then((claimed: boolean) => { if (!claimed) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); social.close(); void accounts.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  assert.equal((await fetch(`${base}/auth/friends-playing`)).status, 401, 'signed in only');
  const r = await fetch(`${base}/auth/friends-playing`, { headers: { authorization: `Bearer ${sessions.mint('alice')}` } });
  assert.equal(r.status, 200);
  const { friends } = (await r.json()) as { friends: { acct: string; name: string; worldId: string; wsPath: string; players: number; mode: string }[] };
  assert.deepEqual(friends, [
    { acct: 'bob', name: 'BobbyB', worldId: 'priv-bob-now', wsPath: '/w/priv-bob-now', players: 2, mode: 'party' },
    { acct: 'cara', name: 'cara', worldId: 'priv-cara', wsPath: '/w/priv-cara', players: 1, mode: 'private' },
  ], 'Bob (occupied party world) and Cara (playing solo, #89): Eve is idle, Dan blocked her');
});
