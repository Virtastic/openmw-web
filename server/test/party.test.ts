// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-106: persisted parties — invite/accept, leave, kick, pass lead, cap of 6, reconnect.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Social, PARTY_MAX } from '../src/core/social';
import { SocialStore } from '../src/core/socialstore';
import type { Player, Roster } from '../src/core/players';

interface Sent { name: string; body: Record<string, unknown> }

function world(store = new SocialStore(':memory:')) {
  const players = new Map<string, Player>();
  const sent = new Map<string, Sent[]>();
  const add = (acct: string): Player => {
    const box: Sent[] = [];
    sent.set(acct, box);
    const p = {
      id: players.size + 1, name: acct, accountKey: acct, inWorld: true, cellKey: '0,0',
      peer: { sendEvent: (n: string, b: Record<string, unknown>) => void box.push({ name: n, body: b }) },
    } as unknown as Player;
    players.set(acct, p);
    return p;
  };
  const roster = {
    activeForAccount: (a: string) => players.get(a),
    inWorld: () => [...players.values()].filter((p) => p.inWorld),
    findByName: (n: string) => players.get(n),
  } as unknown as Roster;
  const social = new Social({
    store, roster,
    displayName: (a) => a,
    resolveName: (n) => (players.has(n) ? n : undefined),
    now: () => 1_700_000_000_000,
  });
  const lastParty = (a: string) => (sent.get(a) ?? []).filter((e) => e.name === 'PartyState').at(-1)?.body;
  return { store, social, add, players, lastParty, stop: () => social.stop() };
}

function join(w: ReturnType<typeof world>, leader: Player, who: Player): void {
  assert.equal(w.social.partyInvite(leader, who.accountKey), 'ok');
  assert.equal(w.social.partyAccept(who, leader.accountKey), 'ok');
}

test('party: invite + accept forms a party led by the inviter; both see it', () => {
  const w = world();
  const a = w.add('a'); const b = w.add('b');
  join(w, a, b);
  assert.equal(w.lastParty('a')?.leader, 'a');
  assert.deepEqual((w.lastParty('b')?.members as { acct: string }[]).map((m) => m.acct), ['a', 'b']);
  assert.equal(w.social.partyAccept(b, 'a'), 'no_request', 'the invite is spent');
  w.stop(); w.store.close();
});

test('party: only the leader invites; a 7th invite is refused', () => {
  const w = world();
  const ps = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => w.add(n));
  for (const p of ps.slice(1, PARTY_MAX)) join(w, ps[0]!, p);
  assert.equal(w.social.partyMembers('a').length, PARTY_MAX);
  assert.equal(w.social.partyInvite(ps[1]!, 'g'), 'not_leader');
  assert.equal(w.social.partyInvite(ps[0]!, 'g'), 'party_full');
  w.stop(); w.store.close();
});

test('party: the leader leaving passes lead to the next member; last two disband', () => {
  const w = world();
  const a = w.add('a'); const b = w.add('b'); const c = w.add('c');
  join(w, a, b); join(w, a, c);
  assert.equal(w.social.partyLeave('a'), 'ok');
  assert.equal(w.store.partyOf('b')?.leader, 'b');
  assert.equal(w.lastParty('a')?.id, 0, 'the leaver is told they are out');
  assert.equal(w.social.partyLeave('c'), 'ok');
  assert.equal(w.store.partyOf('b'), undefined, 'a party of one is disbanded');
  assert.equal(w.lastParty('b')?.id, 0);
  w.stop(); w.store.close();
});

test('party: kick and pass lead are leader-only', () => {
  const w = world();
  const a = w.add('a'); const b = w.add('b'); const c = w.add('c');
  join(w, a, b); join(w, a, c);
  assert.equal(w.social.partyKick(b, 'c'), 'not_leader');
  assert.equal(w.social.partyLead(a, 'b'), 'ok');
  assert.equal(w.social.partyKick(a, 'c'), 'not_leader', 'a passed the lead');
  assert.equal(w.social.partyKick(b, 'c'), 'ok');
  assert.deepEqual(w.social.partyMembers('a'), ['a', 'b']);
  w.stop(); w.store.close();
});

test('party: accepting while already partied is refused; blocks refuse invites', () => {
  const w = world();
  const a = w.add('a'); const b = w.add('b'); const c = w.add('c');
  join(w, a, b);
  assert.equal(w.social.partyInvite(c, 'b'), 'in_party');
  assert.equal(w.social.block(c, 'a'), 'ok');
  assert.equal(w.social.partyInvite(a, 'c'), 'blocked');
  w.stop(); w.store.close();
});

test('party: membership survives a reconnect and a restart', () => {
  const store = new SocialStore(':memory:');
  const w = world(store);
  const a = w.add('a'); const b = w.add('b');
  join(w, a, b);
  w.stop();
  const w2 = world(store); // fresh process state, same store
  const b2 = w2.add('b'); w2.add('a');
  w2.social.onJoin(b2);
  assert.equal(w2.lastParty('b')?.leader, 'a');
  assert.equal((w2.lastParty('b')?.members as unknown[]).length, 2);
  w2.stop(); store.close();
});

test('party: handleEvent routes Party* ops and replies', () => {
  const w = world();
  const a = w.add('a'); const b = w.add('b');
  assert.equal(w.social.handleEvent(a, 'PartyInvite', new Map([['name', 'b']]) as never), true);
  w.social.handleEvent(b, 'PartyAccept', new Map([['acct', 'a']]) as never);
  assert.deepEqual(w.social.partyMembers('b'), ['a', 'b']);
  w.social.handleEvent(b, 'PartyLeave', undefined);
  assert.equal(w.store.partyOf('a'), undefined);
  w.stop(); w.store.close();
});
