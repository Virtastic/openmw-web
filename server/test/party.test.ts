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
  const journals = new Map<string, Record<string, number>>();
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
    journalOf: (p) => journals.get(p.accountKey) ?? {},
  });
  const lastParty = (a: string) => (sent.get(a) ?? []).filter((e) => e.name === 'PartyState').at(-1)?.body;
  return { store, social, add, players, sent, journals, lastParty, stop: () => social.stop() };
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

// OT3-73: the party finder.
test('party finder: a solo sprout leaving the census office is nudged with LFG players, nearest first', () => {
  const w = world();
  const s = w.add('s'); const far = w.add('far'); const near = w.add('near'); w.add('quiet');
  (far as { cellKey: string }).cellKey = '9,9';
  w.social.handleEvent(far, 'SetLfg', new Map([['state', 'on']]));
  w.social.handleEvent(near, 'SetLfg', new Map([['state', 'on']]));
  const nudges = () => (w.sent.get('s') ?? []).filter((e) => e.name === 'PartyFinder' && e.body.nudge === true);
  w.social.onCellChange(s, 'seyda neen, census and excise office', '0,0');
  assert.equal(nudges().length, 1);
  assert.deepEqual((nudges()[0]!.body.players as { acct: string; near: boolean }[]).map((p) => [p.acct, p.near]),
    [['near', true], ['far', false]], 'quiet is not looking; nearby first');
  w.social.onCellChange(s, '0,0', 'seyda neen'); // an ordinary door: no nudge
  assert.equal(nudges().length, 1);
  // far joins near's party: far stops looking, near still leads with room and stays listed.
  join(w, near, far);
  assert.deepEqual(w.social.partyFinder(s).map((p) => p.acct), ['near']);
  w.social.handleEvent(near, 'SetLfg', new Map([['state', 'off']]));
  assert.deepEqual(w.social.partyFinder(s), []);
  // Partied sprouts are not nudged.
  w.social.onCellChange(far, 'imperial prison ship', '0,0');
  assert.equal((w.sent.get('far') ?? []).filter((e) => e.name === 'PartyFinder' && e.body.nudge === true).length, 0);
  w.stop(); w.store.close();
});

test('group travel: the leader takes the strider; members in the cell are offered to follow at the fare', () => {
  const w = world();
  const a = w.add('a'); const b = w.add('b'); const c = w.add('c'); const far = w.add('far');
  join(w, a, b); join(w, a, c); join(w, a, far);
  for (const p of [a, b, c]) (p as { cellKey: string }).cellKey = '-2,-9'; // Seyda Neen
  (far as { cellKey: string }).cellKey = '10,10';
  (b as { pose: unknown }).pose = { x: 1, y: 1, z: 1 };
  w.social.partyTravel(b, '-2,-9', 20); // not the leader: nothing
  assert.equal((w.sent.get('c') ?? []).filter((e) => e.name === 'PartyFollowPrompt').length, 0);
  (a as { cellKey: string }).cellKey = '-3,-2'; // landed in Balmora
  (a as { pose: unknown }).pose = { x: -20000, y: -10000, z: 500 };
  w.social.partyTravel(a, '-2,-9', 20);
  const prompt = (who: string) => (w.sent.get(who) ?? []).find((e) => e.name === 'PartyFollowPrompt')?.body;
  assert.deepEqual(prompt('b'), { leaderAcct: 'a', leaderName: 'a', fare: 20 });
  assert.ok(prompt('c'));
  assert.equal(prompt('far'), undefined, 'a member elsewhere is not asked');
  // b follows: sent to the leader's live spot with the fare to pay; the offer is spent.
  assert.equal(w.social.partyFollow(b, 'a'), 'ok');
  assert.deepEqual((w.sent.get('b') ?? []).find((e) => e.name === 'PartyFollowGo')?.body,
    { cellKey: '-3,-2', x: -20000, y: -10000, z: 500, fare: 20 });
  assert.equal(w.social.partyFollow(b, 'a'), 'no_request');
  // c declines: no Go, and a later accept finds nothing.
  w.social.handleEvent(c, 'PartyFollowDecline', new Map([['acct', 'a']]));
  assert.equal(w.social.partyFollow(c, 'a'), 'no_request');
  assert.equal(w.social.partyFollow(far, 'a'), 'no_request');
  w.stop(); w.store.close();
});

test('party phase: lined up on the leader; out-of-phase members get a hint; sync moves everyone (OT3-84)', () => {
  const w = world();
  const a = w.add('a'); const b = w.add('b'); const c = w.add('c');
  w.journals.set('a', { a1_1_findspymaster: 10 });
  w.journals.set('b', { a1_1_findspymaster: 10 });
  w.journals.set('c', { a1_1_findspymaster: 1, ms_fargothring: 100 });
  join(w, a, b); join(w, a, c);
  const phase = (x: string) => w.lastParty(x)?.phase as { anchor: string; youAnchor: boolean; offBy?: number; quests?: string[] };
  assert.equal(phase('b').anchor, 'a', 'default: the leader');
  assert.equal(phase('a').youAnchor, true);
  assert.equal(phase('b').offBy, 0);
  assert.equal(phase('c').offBy, 2);
  assert.deepEqual(phase('c').quests, ['a1_1_findspymaster', 'ms_fargothring']);
  // Only the leader syncs, and only to a member.
  assert.equal(w.social.partySync(b, 'c'), 'not_leader');
  assert.equal(w.social.partySync(a, 'nobody'), 'not_in_party');
  w.social.handleEvent(a, 'PartySync', new Map([['acct', 'c']]));
  for (const x of ['a', 'b', 'c']) assert.equal(phase(x).anchor, 'c', 'everyone moves to c');
  assert.equal(phase('c').offBy, 0);
  assert.equal(phase('a').offBy, 2);
  // Syncing back to self, passing lead, or the anchor leaving all fall back to the leader.
  assert.equal(w.social.partySync(a, 'a'), 'ok');
  assert.equal(phase('b').anchor, 'a');
  w.social.partySync(a, 'c');
  assert.equal(w.social.partyLeave('c'), 'ok');
  assert.equal(phase('b').anchor, 'a');
  w.social.partySync(a, 'b');
  assert.equal(w.social.partyLead(a, 'b'), 'ok');
  assert.equal(phase('a').anchor, 'b');
  w.stop(); w.store.close();
});
