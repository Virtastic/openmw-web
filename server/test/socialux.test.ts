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
  // Accounts that exist on the SERVER without being in this world — someone in their own
  // game. The shared account index can see them; the local roster cannot, which is the whole
  // distinction the cross-world paths turn on.
  const elsewhere = new Map<string, string>(); // acct -> name
  const register = (acct: string, name: string): string => { elsewhere.set(acct, name); return acct; };
  const byName = (name: string): string | undefined => {
    const lc = name.toLowerCase();
    const here = [...players.values()].find((p) => p.name.toLowerCase() === lc);
    if (here) return here.accountKey;
    for (const [acct, n] of elsewhere) if (n.toLowerCase() === lc) return acct;
    return undefined;
  };
  const roster = {
    activeForAccount: (acct: string) => players.get(acct),
    // In-world only, exactly like the real one: a display name is a thing you see here.
    findByName: (name: string) =>
      [...players.values()].find((p) => p.name.toLowerCase() === name.toLowerCase()),
  } as unknown as Roster;
  const social = new Social({
    store, roster,
    displayName: (acct) => players.get(acct)?.name ?? elsewhere.get(acct),
    resolveName: byName,
    now: () => clock,
  });
  const befriend = (x: Player, y: Player) => {
    social.requestFriend(x, y.name);
    social.requestFriend(y, x.name);
  };
  return {
    store, social, add, befriend, register, clock,
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

// THE FIRST STEP OF PLAYING WITH FRIENDS, and it delivered nothing.
//
// FriendRequestReceived is pushed to the target only if they are in the SENDER'S world, and
// every player normally sits in their own game — which is exactly when "add a friend by their
// username" is the flow you reach for. The request was stored and the recipient was never told,
// in that session or any later one, because nothing sent pending requests at join and the
// FriendList snapshot did not carry them.
test('a friend request reaches someone who was not in the sender\'s world', () => {
  const w = world();
  const a = w.add('ada', 'Ada');

  // Bob is not in this world: no Player, so no live event can reach him.
  w.store.addRequest('ada', 'bob', 1_700_000_000_000, 60_000);
  assert.equal(w.last('bob', 'FriendRequestReceived'), undefined, 'nothing could have been pushed');

  // He arrives. The snapshot he is sent on join must carry it.
  const b = w.add('bob', 'Bob');
  w.social.onJoin(b);
  const list = w.last('bob', 'FriendList');
  assert.ok(list, 'a joining player must receive a FriendList');
  const requests = list.body.requests as { acct: string; name: string }[] | undefined;
  assert.ok(requests, 'the snapshot must carry pending requests');
  assert.deepEqual(requests.map((r) => r.acct), ['ada'],
    'the request waiting for Bob is missing — this is the one that reached nobody');
  assert.equal(requests[0]!.name, 'Ada', 'the row must name the sender, not their account key');

  // And it goes away once it is answered, without needing another push.
  assert.equal(w.social.acceptFriend(b, 'ada'), 'ok');
  const after = w.last('bob', 'FriendList')!;
  assert.deepEqual((after.body.requests as unknown[]), [], 'an accepted request must clear');
  assert.deepEqual((after.body.friends as { acct: string }[]).map((f) => f.acct), ['ada']);
  w.close();
  void a;
});

// The last step of "add a friend by their username", which had never been reachable. The
// request now arrives (see above) and names its sender correctly — and then accepting it
// resolved the sender through the LOCAL ROSTER, so the only requests that could be accepted
// were from someone already standing next to you. Everyone normally sits in their own game.
test('a friend request can be accepted when the sender is in another world', () => {
  const w = world();
  const bob = w.add('bob', 'Bob');
  const ada = w.register('ada', 'Ada'); // on the server, not in this world
  w.store.addRequest(ada, 'bob', w.clock, 60_000);

  // Exactly what the panel's Accept button sends: the op with the sender's NAME, because the
  // account key is deliberately not on the wire.
  w.social.handleEvent(bob, 'FriendAccept', new Map([['name', 'Ada']]) as never);

  const res = w.last('bob', 'SocialResult');
  assert.equal(res?.body.op, 'FriendAccept');
  assert.equal(res?.body.ok, true, `accept was refused: ${JSON.stringify(res?.body)}`);
  assert.ok(w.store.areFriends('ada', 'bob'), 'the friendship was never recorded');
  w.close();
});

// The other half of "come join me". Invites are stored in the shared table precisely so they
// can reach a player in another world (drainInvites delivers them on join) — and accepting
// one only ever meant "teleport to the inviter's coordinates", which no other world process
// can supply. So every invite that actually needed to cross a world answered 'not_online' and
// the card could not be accepted at all.
test('an invite from another world is accepted as a world switch, not refused', () => {
  const w = world();
  const bob = w.add('bob', 'Bob');
  const ada = w.register('ada', 'Ada');
  // Ada is on the server, in her own game: a presence row naming another world.
  w.store.setPresence(ada, 'adas-world', 'Ada', '10,10', false, w.clock);
  w.store.addInvite(ada, 'bob', 'world', w.clock, 60_000);

  w.social.handleEvent(bob, 'InviteAccept', new Map([['acct', ada]]) as never);

  // No gateway is wired here, so the switch cannot complete — but it must have been ATTEMPTED
  // rather than refused outright, and the invite must be spent either way.
  const refusal = w.last('bob', 'SocialResult');
  assert.notEqual(refusal?.body.op, 'InviteAccept',
    `the invite was refused instead of routed: ${JSON.stringify(refusal?.body)}`);
  assert.ok(w.last('bob', 'JoinFriend'), 'the accept never reached the world-switch path');
  assert.equal(w.store.hasInvite(ada, 'bob', w.clock), false, 'the invite was not consumed');
  w.close();
});
