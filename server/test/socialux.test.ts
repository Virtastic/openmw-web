// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Social UX: availability (Online/Offline — a separate axis from presence) and JoinFriend
// authorization. Offline hides a player from friends' lists and refuses inbound invites;
// JoinFriend refuses self / non-friends / offline before it ever consults the gateway.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Social } from '../src/core/social';
import { SocialStore } from '../src/core/socialstore';
import type { Player, Roster } from '../src/core/players';

interface Sent { name: string; body: Record<string, unknown> }

function world() {
  const store = new SocialStore(':memory:');
  const players = new Map<string, Player>();
  const sent = new Map<string, Sent[]>();
  const clock = 1_700_000_000_000;
  const add = (acct: string, name: string): Player => {
    const box: Sent[] = [];
    sent.set(acct, box);
    const p = {
      id: players.size + 1, name, accountKey: acct, inWorld: true, cellKey: '0,0',
      pose: { x: 1, y: 2, z: 3 },
      peer: { sendEvent: (n: string, b: Record<string, unknown>) => void box.push({ name: n, body: b }) },
    } as unknown as Player;
    players.set(acct, p);
    return p;
  };
  const roster = { activeForAccount: (acct: string) => players.get(acct) } as unknown as Roster;
  const social = new Social({
    store, roster,
    displayName: (acct) => players.get(acct)?.name,
    resolveName: (name) => [...players.values()].find((p) => p.name.toLowerCase() === name.toLowerCase())?.accountKey,
    now: () => clock,
  });
  const befriend = (x: Player, y: Player) => {
    social.requestFriend(x, y.name);
    social.requestFriend(y, x.name);
  };
  return {
    store, social, add, befriend,
    last: (acct: string, name: string) => (sent.get(acct) ?? []).filter((e) => e.name === name).at(-1),
    close: () => { social.stop(); store.close(); },
  };
}

test('availability: Offline hides a player from friends and refuses invites; Online restores', () => {
  const w = world();
  const alice = w.add('alice', 'Alice');
  const bob = w.add('bob', 'Bob');
  w.befriend(alice, bob);
  assert.ok(w.store.areFriends('alice', 'bob'));

  // Baseline: Bob is Online, so Alice sees him online.
  assert.equal(w.social.friendList('alice').find((f) => f.acct === 'bob')?.online, true);

  // Bob goes Offline (peels into his solo world).
  assert.equal(w.social.setAvailability(bob, 'offline'), 'ok');
  assert.equal(w.social.friendList('alice').find((f) => f.acct === 'bob')?.online, false,
    'an Offline friend reads as offline even though still connected');
  assert.equal(w.social.availability('bob'), 'offline');
  assert.equal(w.social.invite(alice, 'bob'), 'not_online', 'invites to an Offline player are refused');
  assert.equal(w.social.partyInvite(alice, 'bob'), 'not_online', 'party invites too');

  // Back Online.
  assert.equal(w.social.setAvailability(bob, 'online'), 'ok');
  assert.equal(w.social.friendList('alice').find((f) => f.acct === 'bob')?.online, true);
  assert.equal(w.social.invite(alice, 'bob'), 'ok');
  w.close();
});

test('availability: bad state is rejected and persists across a reload', () => {
  const w = world();
  const bob = w.add('bob', 'Bob');
  assert.notEqual(w.social.setAvailability(bob, 'lurking'), 'ok');
  assert.equal(w.social.setAvailability(bob, 'offline'), 'ok');
  assert.equal(w.store.getAvailability('bob'), 'offline', 'stored for durability across reconnect');
  w.close();
});

test('JoinFriend authorization: self / non-friend / offline are refused before the gateway', async () => {
  const w = world(); // no WorldBrowser configured -> anything past auth would be 'no_gateway'
  const alice = w.add('alice', 'Alice');
  const bob = w.add('bob', 'Bob');

  await w.social.joinFriend(alice, 'alice');
  assert.equal(w.last('alice', 'JoinFriend')?.body.error, 'self');

  await w.social.joinFriend(alice, 'bob'); // not friends yet
  assert.equal(w.last('alice', 'JoinFriend')?.body.error, 'not_friends');

  w.befriend(alice, bob);
  w.social.setAvailability(bob, 'offline');
  await w.social.joinFriend(alice, 'bob');
  assert.equal(w.last('alice', 'JoinFriend')?.body.error, 'not_online',
    'a solo/offline friend is unjoinable');

  // Available friend, but no gateway wired here -> proves auth passed and it reached routing.
  w.social.setAvailability(bob, 'online');
  await w.social.joinFriend(alice, 'bob');
  assert.equal(w.last('alice', 'JoinFriend')?.body.error, 'no_gateway');
  w.close();
});
