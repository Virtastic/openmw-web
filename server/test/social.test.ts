// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase C policy. The happy path (two people befriend) is the least interesting thing here;
// these concentrate on the rules whose violation is invisible — presence leaking to a
// blocked account, a reconnect storming friends, an invite surviving a block.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Social, socialTuning } from '../src/core/social';
import { SocialStore } from '../src/core/socialstore';
import type { Player, Roster } from '../src/core/players';

interface Sent { name: string; body: Record<string, unknown> }

function world() {
  const store = new SocialStore(':memory:');
  const players = new Map<string, Player>();
  const sent = new Map<string, Sent[]>();
  let clock = 1_700_000_000_000;

  const add = (acct: string, name: string, opts: { inWorld?: boolean; cellKey?: string } = {}): Player => {
    const box: Sent[] = [];
    sent.set(acct, box);
    const p = {
      id: players.size + 1,
      name,
      accountKey: acct,
      inWorld: opts.inWorld ?? true,
      cellKey: opts.cellKey ?? '0,0',
      pose: { x: 1, y: 2, z: 3 },
      peer: { sendEvent: (n: string, b: Record<string, unknown>) => void box.push({ name: n, body: b }) },
    } as unknown as Player;
    players.set(acct, p);
    return p;
  };

  const roster = { activeForAccount: (acct: string) => players.get(acct) } as unknown as Roster;
  const social = new Social({
    store,
    roster,
    displayName: (acct) => players.get(acct)?.name,
    resolveName: (name) => [...players.values()].find((p) => p.name.toLowerCase() === name.toLowerCase())?.accountKey,
    now: () => clock,
  });

  return {
    store, social, add, sent, players,
    events: (acct: string, name: string) => (sent.get(acct) ?? []).filter((e) => e.name === name),
    advance: (ms: number) => { clock += ms; },
    now: () => clock,
    close: () => { social.stop(); store.close(); },
  };
}

test('social: mutual requests resolve into a friendship instead of deadlocking', () => {
  const w = world();
  const alice = w.add('alice', 'Alice');
  const bob = w.add('bob', 'Bob');

  assert.equal(w.social.requestFriend(alice, 'Bob'), 'sent');
  // Bob independently presses "add friend" rather than "accept". Without this path both
  // sides hold a request for the other and neither ever becomes a friend.
  assert.equal(w.social.requestFriend(bob, 'Alice'), 'accepted');
  assert.ok(w.store.areFriends('alice', 'bob'));
  assert.equal(w.events('alice', 'FriendList').length > 0, true, 'both sides must be refreshed');
  assert.equal(w.events('bob', 'FriendList').length > 0, true);
  w.close();
});

test('social: blocking after a request is pending kills the request', () => {
  const w = world();
  const alice = w.add('alice', 'Alice');
  const mallory = w.add('mallory', 'Mallory');

  assert.equal(w.social.requestFriend(mallory, 'Alice'), 'sent');
  // Alice blocks AFTER the request is already pending. block() drops pending requests both
  // ways, so the request is gone rather than merely unacceptable — hence 'no_request'.
  assert.equal(w.social.block(alice, 'Mallory'), 'ok');
  assert.equal(w.social.acceptFriend(alice, 'mallory'), 'no_request');
  assert.equal(w.store.areFriends('alice', 'mallory'), false);
  w.close();
});

test('social: accept re-checks the block even if a request somehow survived', () => {
  const w = world();
  const alice = w.add('alice', 'Alice');
  const mallory = w.add('mallory', 'Mallory');

  // Written against the STORE directly, bypassing block(), to leave a pending request
  // alongside a live block. That combination should be unreachable today — block() clears
  // requests — but the accept path must not depend on that remaining true, because the
  // failure if it ever changes is a blocked person silently becoming a friend.
  // Stamped with the world clock, not 0: a request dated at the epoch is already expired
  // against a realistic `now`, and the accept would fail for that reason instead.
  w.store.addRequest('mallory', 'alice', w.now(), socialTuning.requestTtlMs);
  w.store.addBlock('alice', 'mallory', w.now());

  assert.equal(w.social.acceptFriend(alice, 'mallory'), 'blocked');
  assert.equal(w.store.areFriends('alice', 'mallory'), false);
  w.close();
});

test('social: blocking unfriends and stops presence and location leaking', () => {
  const w = world();
  const alice = w.add('alice', 'Alice');
  const mallory = w.add('mallory', 'Mallory');
  w.store.addFriend('alice', 'mallory', 1);

  assert.equal(w.social.block(alice, 'Mallory'), 'ok');
  assert.equal(w.store.areFriends('alice', 'mallory'), false, 'a block must imply unfriending');
  // The blocked party must not retain a friend entry carrying Alice's cellKey.
  assert.deepEqual(w.social.friendList('mallory'), []);
  assert.deepEqual(w.social.friendList('alice'), []);
  w.close();
});

test('social: an invite cannot be accepted once blocked, and cannot be stacked', () => {
  const w = world();
  const alice = w.add('alice', 'Alice');
  const bob = w.add('bob', 'Bob');

  assert.equal(w.social.invite(alice, 'bob'), 'ok');
  assert.equal(w.social.invite(alice, 'bob'), 'ok');
  assert.equal(w.events('bob', 'InviteReceived').length, 2, 'each invite notifies');

  // Bob blocks Alice; the already-delivered invite must become unusable.
  assert.equal(w.social.block(bob, 'Alice'), 'ok');
  const res = w.social.acceptInvite(bob, 'alice');
  assert.equal(res.ok, false);
  w.close();
});

test('social: an expired invite cannot be accepted', () => {
  const w = world();
  const alice = w.add('alice', 'Alice');
  const bob = w.add('bob', 'Bob');
  assert.equal(w.social.invite(alice, 'bob'), 'ok');
  w.advance(socialTuning.inviteTtlMs + 1);
  assert.equal(w.social.acceptInvite(bob, 'alice').ok, false, 'invites must expire');
  w.close();
});

test('social: accepting an invite yields the host position to travel to', () => {
  const w = world();
  const alice = w.add('alice', 'Alice', { cellKey: '-2,-9' });
  const bob = w.add('bob', 'Bob');
  assert.equal(w.social.invite(alice, 'bob'), 'ok');
  const res = w.social.acceptInvite(bob, 'alice');
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.cellKey, '-2,-9');
  // Single-use: the same invite must not teleport repeatedly.
  assert.equal(w.social.acceptInvite(bob, 'alice').ok, false);
  w.close();
});

test('social: a reconnect inside the grace window never shows the player as offline', async () => {
  const w = world();
  const alice = w.add('alice', 'Alice');
  const bob = w.add('bob', 'Bob');
  w.store.addFriend('alice', 'bob', 1);

  w.social.onJoin(alice);
  const before = w.events('bob', 'PresenceUpdate').length;
  // Alice drops and comes straight back, which A1's auto-reconnect makes routine. If the
  // offline announcement were immediate, every friend would see a flicker on every blip.
  w.social.onLeave(alice);
  w.social.onJoin(alice);
  await new Promise((r) => setTimeout(r, socialTuning.presenceGraceMs > 50 ? 50 : 1));
  assert.equal(w.events('bob', 'PresenceUpdate').length, before,
    'a reconnect inside the grace window must produce no presence churn');
  w.close();
});

test('social: presence and friend lists never reach a blocked account', () => {
  const w = world();
  const alice = w.add('alice', 'Alice');
  const mallory = w.add('mallory', 'Mallory');
  w.store.addFriend('alice', 'mallory', 1);
  w.store.addBlock('mallory', 'alice', 1); // mallory blocks alice

  w.social.onJoin(alice);
  assert.equal(w.events('mallory', 'PresenceUpdate').length, 0,
    'a blocked account must not learn when the other comes online');
  w.close();
});

test('social: outstanding friend requests are capped', () => {
  const w = world();
  const alice = w.add('alice', 'Alice');
  for (let i = 0; i < socialTuning.maxOutstandingRequests; i++) w.add(`u${i}`, `User${i}`);
  for (let i = 0; i < socialTuning.maxOutstandingRequests; i++) {
    assert.equal(w.social.requestFriend(alice, `User${i}`), 'sent');
  }
  w.add('extra', 'Extra');
  assert.equal(w.social.requestFriend(alice, 'Extra'), 'too_many_requests',
    'an uncapped request channel is a spam vector that costs the sender nothing');
  w.close();
});

test('social: you cannot friend or invite yourself, or a name that does not exist', () => {
  const w = world();
  const alice = w.add('alice', 'Alice');
  assert.equal(w.social.requestFriend(alice, 'Alice'), 'self');
  assert.equal(w.social.requestFriend(alice, 'Nobody'), 'no_such_player');
  assert.equal(w.social.invite(alice, 'alice'), 'self');
  w.close();
});

test('social: presence mode gates location disclosure, not just friendship', () => {
  const w = world();
  const alice = w.add('alice', 'Alice', { cellKey: '-2,-9' });
  const bob = w.add('bob', 'Bob');
  w.store.addFriend('alice', 'bob', w.now());

  // Default is friends-only: a friend sees where you are.
  assert.equal(w.social.friendList('bob')[0]!.cellKey, '-2,-9');

  // Private must hide the location from FRIENDS too — that is the whole point of picking
  // it. A mode that only hid you from strangers would be indistinguishable from the
  // default and would quietly not do what the player asked.
  assert.equal(w.social.setPresenceMode(alice, 'private'), 'ok');
  assert.equal(w.social.friendList('bob')[0]!.cellKey, undefined, 'private still leaked a location to a friend');
  assert.equal(w.social.friendList('bob')[0]!.online, true, 'private hides WHERE, not THAT you are online');
  w.close();
});

test('social: private refuses incoming invites, not merely location', () => {
  const w = world();
  const alice = w.add('alice', 'Alice');
  const bob = w.add('bob', 'Bob');
  assert.equal(w.social.setPresenceMode(bob, 'private'), 'ok');
  assert.equal(w.social.invite(alice, 'bob'), 'private', 'private must mean do-not-contact');
  assert.equal(w.social.partyInvite(alice, 'bob'), 'private');
  w.close();
});

test('social: inviting with no party creates one; the leader leaving hands over', () => {
  const w = world();
  const alice = w.add('alice', 'Alice');
  const bob = w.add('bob', 'Bob');
  const carol = w.add('carol', 'Carol');

  // No explicit "create party" step — nobody wants a party of one.
  assert.equal(w.social.partyInvite(alice, 'bob'), 'ok');
  assert.equal(w.social.partyAccept(bob, 'alice'), 'ok');
  assert.equal(w.social.partyInvite(alice, 'carol'), 'ok');
  assert.equal(w.social.partyAccept(carol, 'alice'), 'ok');
  const initial = w.social.partyView('bob');
  assert.ok(initial, 'bob should be in a party');
  assert.equal(initial.members.length, 3);
  assert.equal(initial.leader, 'alice');

  // The leader leaving hands over rather than dissolving: ejecting everyone because one
  // person left is worse than an arbitrary successor.
  w.social.partyLeave('alice');
  const after = w.social.partyView('bob');
  assert.ok(after, 'the party must survive its leader leaving');
  assert.equal(after!.members.length, 2);
  assert.ok(after!.leader === 'bob' || after!.leader === 'carol', `leadership was not handed over: ${after!.leader}`);
  assert.equal(w.social.partyView('alice'), null, 'the leaver must be out of the party');
  w.close();
});

test('social: a party of one is disbanded rather than left dangling', () => {
  const w = world();
  const alice = w.add('alice', 'Alice');
  const bob = w.add('bob', 'Bob');
  assert.equal(w.social.partyInvite(alice, 'bob'), 'ok');
  assert.equal(w.social.partyAccept(bob, 'alice'), 'ok');
  w.social.partyLeave('bob');
  assert.equal(w.social.partyView('alice'), null, 'a one-person party should not persist');
  w.close();
});

test('social: you cannot be in two parties at once', () => {
  const w = world();
  const alice = w.add('alice', 'Alice');
  const bob = w.add('bob', 'Bob');
  const carol = w.add('carol', 'Carol');
  assert.equal(w.social.partyInvite(alice, 'bob'), 'ok');
  assert.equal(w.social.partyAccept(bob, 'alice'), 'ok');
  assert.equal(w.social.partyInvite(carol, 'bob'), 'already_in_party');
  w.close();
});
