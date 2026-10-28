// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// THE LAUNCHER'S "FRIENDS PLAYING NOW". A drop-in used to cost two full boots -- home, then the
// social panel, then a reload into the friend's world. GET /auth/friends-playing tells the
// launcher which friends are in the world right now (OT3-28: one world, read from the presence
// table). Friends only, blocks respected, bots and stale presence not listed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AccountStore } from '../src/core/accounts';
import { LockerSessionStore } from '../src/auth/identities';
import { SocialStore } from '../src/core/socialstore';
import { friendsPlayingRoutes } from '../src/gateway/frontdoor';
import { tmpDataDir } from './helpers';

test('friends-playing lists friends present in the world, blocks respected', async (t) => {
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
  social.setPresence('bob', 'vvardenfell', 'BobbyB', 'cell', false, now);
  social.setPresence('cara', 'vvardenfell', 'Cara', 'cell', false, now);
  social.setPresence('dan', 'vvardenfell', 'Dan', 'cell', false, now);
  social.setPresence('eve', 'vvardenfell', 'Eve', 'cell', false, now - 60_000); // stale: gone
  const worlds = [{ id: 'vvardenfell', up: true, playerCount: 3, players: [] }];
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
    { acct: 'bob', name: 'BobbyB', worldId: 'vvardenfell', wsPath: '/w/vvardenfell', players: 3, mode: 'public' },
    { acct: 'cara', name: 'cara', worldId: 'vvardenfell', wsPath: '/w/vvardenfell', players: 3, mode: 'public' },
  ], 'Bob and Cara are in the world: Eve went stale, Dan blocked her');
});
