// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Party travel (plan 2.5.1): leader-only group world-switch, PartyTravel fan-out to
// co-present members, party persistence across world processes (shared store), offline
// grace never ejecting a member, and the staleness sweep.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Social, PARTY_STALE_MS } from '../src/core/social';
import { SocialStore } from '../src/core/socialstore';
import type { Player, Roster } from '../src/core/players';
import type { WorldBrowser, WorldEntry } from '../src/core/worldbrowser';

type Sent = { name: string; body: Record<string, unknown> };

// Two "world processes" sharing one store: each world() is its own Social + roster, the
// SocialStore is the shared SQLite.
function harness(store: SocialStore, worlds?: Partial<WorldBrowser>) {
  const players = new Map<string, Player>();
  const sent = new Map<string, Sent[]>();
  let clock = 1_700_000_000_000;

  const add = (acct: string, name: string): Player => {
    const box: Sent[] = sent.get(acct) ?? [];
    sent.set(acct, box);
    const p = {
      id: players.size + 1,
      name,
      accountKey: acct,
      charId: acct,
      inWorld: true,
      cellKey: '0,0',
      pose: { x: 1, y: 2, z: 3 },
      peer: { sendEvent: (n: string, b: Record<string, unknown>) => void box.push({ name: n, body: b }) },
    } as unknown as Player;
    players.set(acct, p);
    return p;
  };

  const roster = {
    activeForAccount: (acct: string) => players.get(acct),
  } as unknown as Roster;

  const social = new Social({
    store,
    roster,
    displayName: (acct) => players.get(acct)?.name,
    resolveName: (name) => [...players.values()].find((p) => p.name.toLowerCase() === name.toLowerCase())?.accountKey,
    now: () => clock,
    ...(worlds ? { worlds: worlds as WorldBrowser } : {}),
  });

  return {
    social, add, players,
    events: (acct: string, name: string) => (sent.get(acct) ?? []).filter((e) => e.name === name),
    remove: (acct: string) => players.delete(acct),
    advance: (ms: number) => { clock += ms; },
    close: () => social.stop(),
  };
}

function fakeWorlds(publicUp = true): Partial<WorldBrowser> & { created: string[] } {
  const created: string[] = [];
  return {
    created,
    enabled: true,
    async create(_p: Player, id: string, mode: string) {
      created.push(id);
      return { world: { id, mode, name: id, host: 'h', port: 9001, playerCount: 0, maxPlayers: 8, up: true } };
    },
    async list() {
      const worlds: WorldEntry[] = publicUp
        ? [{ id: 'vvardenfell', mode: 'public', name: 'Vvardenfell', host: 'h', port: 8080, playerCount: 3, maxPlayers: 64, up: true }]
        : [];
      return { worlds };
    },
  } as never;
}

function makeParty(w: ReturnType<typeof harness>): void {
  const alice = w.add('alice', 'Alice');
  const bob = w.add('bob', 'Bob');
  w.social.onJoin(alice);
  w.social.onJoin(bob);
  assert.equal(w.social.partyInvite(alice, 'bob'), 'ok');
  assert.equal(w.social.partyAccept(bob, 'alice'), 'ok');
}

test('party travel: leader-only, fans out to co-present members with the destination', async () => {
  const store = new SocialStore(':memory:');
  const worlds = fakeWorlds();
  const w = harness(store, worlds);
  makeParty(w);

  // A non-leader may not move the group.
  await w.social.partyTravel(w.players.get('bob')!, 'public');
  assert.equal(w.events('bob', 'SocialResult').filter((e) => e.body['op'] === 'PartyTravel'
    && e.body['detail'] === 'not_leader').length, 1);

  // PUBLIC is the only destination. A party is together either in the leader's own world
  // flipped to Party or in the shared world; the old dedicated `party-<key>` world was a
  // blank process with nobody's progress in it, so it is gone.
  await w.social.partyTravel(w.players.get('alice')!, 'party');
  assert.equal(w.events('alice', 'SocialResult').filter((e) => e.body['op'] === 'PartyTravel'
    && e.body['detail'] === 'bad_target').length, 1,
    'a dedicated party world must no longer be reachable');
  assert.equal(worlds.created.length, 0, 'party travel must never create a world');

  // Leader travels to public: both members get the same destination, nothing is created.
  await w.social.partyTravel(w.players.get('alice')!, 'public');
  const a = w.events('alice', 'PartyTravel');
  const b = w.events('bob', 'PartyTravel');
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0]!.body['worldId'], b[0]!.body['worldId']);
  assert.equal(a[0]!.body['worldId'], 'vvardenfell');
  assert.equal(a[0]!.body['port'], 8080);
  assert.equal(worlds.created.length, 0, 'public travel must not create a world');
  w.close();
  store.close();
});

test('party travel: no gateway and bad targets fail loudly', async () => {
  const store = new SocialStore(':memory:');
  const w = harness(store); // no worlds browser at all
  makeParty(w);
  await w.social.partyTravel(w.players.get('alice')!, 'party');
  assert.equal(w.events('alice', 'SocialResult').filter((e) => e.body['detail'] === 'no_gateway').length, 1);
  w.close();

  const w2 = harness(store, fakeWorlds(false));
  const carol = w2.add('carol', 'Carol');
  const dave = w2.add('dave', 'Dave');
  w2.social.onJoin(carol);
  w2.social.onJoin(dave);
  assert.equal(w2.social.partyInvite(carol, 'dave'), 'ok');
  assert.equal(w2.social.partyAccept(dave, 'carol'), 'ok');
  await w2.social.partyTravel(carol, 'nowhere');
  assert.equal(w2.events('carol', 'SocialResult').filter((e) => e.body['detail'] === 'bad_target').length, 1);
  await w2.social.partyTravel(carol, 'public');
  assert.equal(w2.events('carol', 'SocialResult').filter((e) => e.body['detail'] === 'no_public_world').length, 1);
  w2.close();
  store.close();
});

test('party persists across world processes: members arriving elsewhere are still a party', () => {
  const store = new SocialStore(':memory:');
  const w1 = harness(store);
  makeParty(w1); // formed in "world 1"
  w1.close();

  // "World 2" is a different process: fresh Social, same store. Members arrive one by one.
  const w2 = harness(store);
  const alice2 = w2.add('alice', 'Alice');
  w2.social.onJoin(alice2);
  const view = w2.social.partyView('alice');
  assert.ok(view, 'party must hydrate from the store in a new world');
  assert.equal(view.leader, 'alice');
  assert.deepEqual(view.members.map((m) => m.acct).sort(), ['alice', 'bob']);

  const bob2 = w2.add('bob', 'Bob');
  w2.social.onJoin(bob2);
  assert.equal(w2.social.partyView('bob')?.leader, 'alice');
  w2.close();
  store.close();
});

test('offline grace never ejects a member; explicit leave and staleness do', () => {
  const store = new SocialStore(':memory:');
  const w = harness(store);
  makeParty(w);

  // Bob's socket drops and the grace window lapses: membership must SURVIVE (he may be
  // mid-hop to another world).
  w.social.onLeave(w.players.get('bob')!);
  w.remove('bob');
  w.advance(60_000);
  // (the timer is real; simulate its lapse by checking the store directly)
  assert.ok(store.partyOfAccount('bob'), 'a dropped socket must not eject a member');

  // Explicit leave does.
  w.social.partyLeave('bob');
  assert.equal(store.partyOfAccount('bob'), undefined);
  assert.equal(store.partyOfAccount('alice'), undefined, 'party of one dissolves');
  w.close();

  // Staleness: an untouched party dissolves on next load.
  const w2 = harness(store);
  makeParty(w2);
  w2.close();
  const w3 = harness(store);
  const alice3 = w3.add('alice', 'Alice');
  // Fast-forward beyond the stale window before the member logs back in.
  w3.advance(PARTY_STALE_MS + 1);
  w3.social.onJoin(alice3);
  assert.equal(w3.social.partyView('alice'), null, 'a stale party must not resurrect');
  assert.equal(store.partyOfAccount('alice'), undefined);
  w3.close();
  store.close();
});

// Joining a party has to put you WITH the party. Accepting used to only change membership,
// and joinFriend assumed every party lives in its own `party-<key>` world — so a group that
// had gone to the shared world pulled joiners into an empty one instead.
test('joining a party routes you to where the party actually is', async () => {
  const store = new SocialStore(':memory:');
  const worlds = fakeWorlds();
  const w = harness(store, worlds);
  const alice = w.add('alice', 'Alice');
  const bob = w.add('bob', 'Bob');
  w.social.onJoin(alice);
  w.social.onJoin(bob);
  assert.equal(w.social.partyInvite(alice, 'bob'), 'ok');

  // Leader is standing right here: no dial, just land next to them.
  w.social.handleEvent(bob, 'PartyAccept', new Map<string, string>([['acct', 'alice']]));
  const near = w.events('bob', 'InviteAccepted');
  assert.equal(near.length, 1, 'a co-present leader should teleport the joiner, not redial them');
  assert.equal(near[0]!.body['cellKey'], '0,0');
  assert.equal(near[0]!.body['x'], 1);
  assert.equal(w.events('bob', 'PartyTravel').length, 0, 'no world hop when the leader is here');

  // Group moves to the shared world, then a third player joins from somewhere the leader is not.
  await w.social.partyTravel(alice, 'public');
  const cara = w.add('cara', 'Cara');
  w.social.onJoin(cara);
  assert.equal(w.social.partyInvite(alice, 'cara'), 'ok');
  w.remove('alice'); // leader no longer visible from this world
  const createdBefore = worlds.created.length;
  w.social.handleEvent(cara, 'PartyAccept', new Map<string, string>([['acct', 'alice']]));
  const trav = w.events('cara', 'PartyTravel');
  assert.equal(trav.length, 1, 'a joiner whose party is elsewhere got no destination');
  assert.equal(trav[0]!.body['worldId'], 'vvardenfell',
    'joiner was sent to a party world while the party was in the shared world');
  assert.equal(worlds.created.length, createdBefore, 'routing must not create a world');
  w.close();
  store.close();
});

test('joinFriend follows the party to the shared world instead of making an empty one', async () => {
  const store = new SocialStore(':memory:');
  const worlds = fakeWorlds();
  const w = harness(store, worlds);
  makeParty(w);
  const alice = w.players.get('alice')!;
  await w.social.partyTravel(alice, 'public');
  const createdBefore = worlds.created.length;

  const dave = w.add('dave', 'Dave');
  w.social.onJoin(dave);
  store.addFriend('dave', 'alice', 1_700_000_000_000);
  await w.social.joinFriend(dave, 'alice');
  const jf = w.events('dave', 'JoinFriend');
  assert.equal(jf.length, 1);
  assert.equal(jf[0]!.body['ok'], true, 'joinFriend failed: ' + JSON.stringify(jf[0]!.body));
  assert.equal(jf[0]!.body['worldId'], 'vvardenfell',
    'joinFriend sent the player to a party world the party had already left');
  assert.equal(worlds.created.length, createdBefore, 'no world should be created');
  w.close();
  store.close();
});

// Joining a friend who never left their own world. This world process cannot see into
// another world's roster, so before the gateway lookup it dead-ended on 'not_travelled' —
// which is most of the time, since a party that has not travelled is sitting in the leader's
// own world. The destination still authorizes the arrival (mayJoinWorld); this only answers
// WHERE they are.
test('joinFriend reaches a friend sitting in their own world', async () => {
  const store = new SocialStore(':memory:');
  const worlds = fakeWorlds();
  // The gateway knows who owns what; this world does not.
  (worlds as unknown as { ownerWorld: (a: string) => Promise<unknown> }).ownerWorld =
    async (acct: string) => (acct === 'alice'
      ? { id: 'priv-alice', mode: 'party', name: 'p', host: 'h', port: 9100,
          playerCount: 1, maxPlayers: 8, up: true, ownerAccount: 'alice' }
      : undefined);
  const w = harness(store, worlds);
  const alice = w.add('alice', 'Alice');
  w.social.onJoin(alice);
  const dave = w.add('dave', 'Dave');
  w.social.onJoin(dave);
  store.addFriend('dave', 'alice', 1_700_000_000_000);

  await w.social.joinFriend(dave, 'alice');
  const jf = w.events('dave', 'JoinFriend');
  assert.equal(jf.length, 1);
  assert.equal(jf[0]!.body['ok'], true, 'joinFriend failed: ' + JSON.stringify(jf[0]!.body));
  assert.equal(jf[0]!.body['worldId'], 'priv-alice',
    'a friend in their own world must be reachable, not a dead end');
  assert.equal(worlds.created.length, 0, 'no world may be created to reach someone');
  w.close();
  store.close();
});

// Invites cross worlds. They used to live in an in-memory Map, so an invite could only ever
// reach someone already connected to the SAME world process — "invite your friend" worked
// exactly when you did not need it. They now live in the shared store and are drained on
// join, so the two "world processes" here share one SocialStore, as real worlds do.
test('a party invite reaches a friend who is in another world', async () => {
  const store = new SocialStore(':memory:');
  const w1 = harness(store, fakeWorlds());   // world A: the leader
  const w2 = harness(store, fakeWorlds());   // world B: the invitee
  const alice = w1.add('alice', 'Alice');
  w1.social.onJoin(alice);
  const bob = w2.add('bob', 'Bob');
  w2.social.onJoin(bob);

  // Alice cannot see Bob at all: he is not in her roster.
  assert.equal(w1.players.get('bob'), undefined, 'the fixture must model separate worlds');
  assert.equal(w1.social.partyInvite(alice, 'bob'), 'ok',
    'inviting someone in another world must be allowed — that is the normal case');

  // Nothing was pushed to Bob's world by the sender's world...
  assert.equal(w2.events('bob', 'PartyInviteReceived').length, 0);
  // ...but the invite is in the shared mailbox, so HIS world delivers it when he joins.
  w2.social.onJoin(bob);
  const got = w2.events('bob', 'PartyInviteReceived');
  assert.equal(got.length, 1, 'the invite never reached the other world');
  assert.equal(got[0]!.body['fromAcct'], 'alice');

  // And he can accept it from over there.
  assert.equal(w2.social.partyAccept(bob, 'alice'), 'ok', 'accepting a cross-world invite failed');
  // Single-use: accepting CONSUMES the mailbox row, so a replay finds no invite at all.
  // ('no_request', not 'already_in_party' — the invite check runs first, which is what makes
  // a replayed accept harmless rather than a second join attempt.)
  assert.equal(w2.social.partyAccept(bob, 'alice'), 'no_request');
  w1.close(); w2.close();
  store.close();
});

test('an expired invite cannot be accepted, and a block drops it', async () => {
  const store = new SocialStore(':memory:');
  const w = harness(store, fakeWorlds());
  const alice = w.add('alice', 'Alice');
  const bob = w.add('bob', 'Bob');
  w.social.onJoin(alice);
  w.social.onJoin(bob);

  assert.equal(w.social.partyInvite(alice, 'bob'), 'ok');
  w.advance(3 * 60 * 1000); // past inviteTtlMs (2 min)
  assert.equal(w.social.partyAccept(bob, 'alice'), 'no_request',
    'an expired invite must not be acceptable');

  // A fresh one, then a block: blocking must drop pending invites both ways.
  w.advance(1000);
  assert.equal(w.social.partyInvite(alice, 'bob'), 'ok');
  w.social.block(bob, 'alice');
  // Blocking DROPS the pending invite rather than merely refusing it later, so there is
  // nothing left to accept. That is the stronger outcome: no row survives to be replayed.
  assert.equal(w.social.partyAccept(bob, 'alice'), 'no_request');
  w.close();
  store.close();
});

// A MEMBERSHIP CHANGE MADE IN ANOTHER WORLD MUST BE VISIBLE HERE.
//
// social.ts kept `parties` and `partyOf` as a per-process cache, and loadParty began with
// `if (this.partyOf.has(acct)) return`. The maps were only ever added to for remote changes —
// deletions happened solely for actions taken in the same process. So a member who left in
// world B stayed in world A's party forever: the panel re-asserted them every 10 seconds via
// refreshPresenceViews, a leader handover in B never reached A (both processes then believed
// a different account led, and both passed isPartyLeader), and partyMembersOf — which is the
// authorization check for VoiceSignal — kept returning someone who had walked out.
test('a member who leaves in one world stops being a member in the other', async () => {
  const store = new SocialStore(':memory:');
  const w1 = harness(store, fakeWorlds());
  const w2 = harness(store, fakeWorlds());
  const alice = w1.add('alice', 'Alice');
  const bob = w2.add('bob', 'Bob');
  w1.social.onJoin(alice);
  w2.social.onJoin(bob);

  assert.equal(w1.social.partyInvite(alice, 'bob'), 'ok');
  w2.social.onJoin(bob);
  assert.equal(w2.social.partyAccept(bob, 'alice'), 'ok');

  // Both worlds agree there is a party of two.
  assert.deepEqual(w1.social.partyMembersOf('alice').sort(), ['alice', 'bob']);
  assert.deepEqual(w2.social.partyMembersOf('bob').sort(), ['alice', 'bob']);

  // Bob leaves from HIS world. World A took no part in this.
  w2.social.partyLeave('bob');

  assert.ok(!w1.social.partyMembersOf('alice').includes('bob'),
    'world A still calls Bob a party member, so voice signalling to him is still authorised');
  assert.equal(w1.social.partyView('alice'), null,
    'the panel in world A must stop showing a party of one it re-asserts every 10 seconds');
  w1.close(); w2.close();
  store.close();
});

// Leadership is what gates PartyTravel and the party settings. Two processes each believing
// they hold it means two people can drag the group to different worlds.
test('a leader handover in one world is seen by the other', async () => {
  const store = new SocialStore(':memory:');
  const w1 = harness(store, fakeWorlds());
  const w2 = harness(store, fakeWorlds());
  const alice = w1.add('alice', 'Alice');
  const bob = w2.add('bob', 'Bob');
  const carol = w2.add('carol', 'Carol');
  w1.social.onJoin(alice);
  w2.social.onJoin(bob);
  w2.social.onJoin(carol);

  assert.equal(w1.social.partyInvite(alice, 'bob'), 'ok');
  w2.social.onJoin(bob);
  assert.equal(w2.social.partyAccept(bob, 'alice'), 'ok');
  assert.equal(w1.social.partyInvite(alice, 'carol'), 'ok');
  w2.social.onJoin(carol);
  assert.equal(w2.social.partyAccept(carol, 'alice'), 'ok');

  assert.equal(w1.social.isPartyLeader('alice'), true);
  assert.equal(w2.social.isPartyLeader('alice'), true);

  // Alice leaves from her own world, which hands leadership on.
  w1.social.partyLeave('alice');

  assert.equal(w1.social.isPartyLeader('alice'), false, 'the old leader still leads in world A');
  assert.equal(w2.social.isPartyLeader('alice'), false,
    'world B still believes Alice leads, so two accounts can both drag the party');
  const leaderNow = w2.social.partyView('bob')?.leader;
  assert.ok(leaderNow === 'bob' || leaderNow === 'carol', `unexpected leader ${String(leaderNow)}`);
  assert.equal(w1.social.partyView('bob')?.leader, leaderNow,
    'the two worlds name different party leaders');
  store.close();
  w1.close(); w2.close();
});

// INVITING SOMEONE MUST NOT PUT YOU IN A PARTY BY YOURSELF.
//
// partyInvite used to call partyCreate immediately, so the inviter was in a real, persisted
// party of one from the moment they clicked. The already_in_party check reads the store, so
// from everyone else's side they were instantly un-invitable — and if the invitee never
// accepted, the invite expired in two minutes and the phantom party outlived it. "I invited
// Bob, he never got it, and now nobody can invite me."
test('an unaccepted invite leaves the inviter invitable by someone else', async () => {
  const store = new SocialStore(':memory:');
  const w = harness(store, fakeWorlds());
  const alice = w.add('alice', 'Alice');
  const bob = w.add('bob', 'Bob');
  const carol = w.add('carol', 'Carol');
  [alice, bob, carol].forEach((p) => w.social.onJoin(p));

  assert.equal(w.social.partyInvite(alice, 'bob'), 'ok');
  assert.equal(store.partyOfAccount('alice'), undefined,
    'inviting created a party of one, which makes the inviter un-invitable');

  // Carol can still invite Alice, because Alice is not actually in a party.
  assert.equal(w.social.partyInvite(carol, 'alice'), 'ok');
  assert.equal(w.social.partyAccept(alice, 'carol'), 'ok');
  assert.deepEqual(w.social.partyMembersOf('alice').sort(), ['alice', 'carol']);
  w.close();
  store.close();
});

// The party still has to come into existence when someone accepts.
test('accepting an invite creates the party with the inviter leading', async () => {
  const store = new SocialStore(':memory:');
  const w = harness(store, fakeWorlds());
  const alice = w.add('alice', 'Alice');
  const bob = w.add('bob', 'Bob');
  w.social.onJoin(alice); w.social.onJoin(bob);

  assert.equal(w.social.partyInvite(alice, 'bob'), 'ok');
  assert.equal(w.social.partyAccept(bob, 'alice'), 'ok');
  assert.deepEqual(w.social.partyMembersOf('alice').sort(), ['alice', 'bob']);
  assert.equal(w.social.isPartyLeader('alice'), true);
  w.close();
  store.close();
});

// The cap belongs to the STORE, in the same call as the insert. social.ts checked its own
// in-memory member set, which is per-process: two invitees accepting in two different world
// processes both read the same stale count and both inserted, and the party ended up over its
// limit with party-scaled loot and quest credit fanning out across it.
test('the store refuses a member past the cap, whatever the caller believed', async () => {
  const store = new SocialStore(':memory:');
  store.partyCreate('pk', 'alice', 1);
  for (const m of ['b', 'c', 'd', 'e', 'f', 'g', 'h']) {
    assert.equal(store.partyAddMember('pk', m, 1, 8), true, `adding ${m}`);
  }
  assert.equal(store.partyMembers('pk').length, 8);

  // The ninth, from a process whose cache still said seven.
  assert.equal(store.partyAddMember('pk', 'i', 1, 8), false);
  assert.equal(store.partyMembers('pk').length, 8, 'the party went over its cap');

  // Re-adding someone already in the party is not a new seat, so it must not be refused.
  assert.equal(store.partyAddMember('pk', 'h', 2, 8), true);
  assert.equal(store.partyMembers('pk').length, 8);
  store.close();
});

test('a full party refuses another invite end to end', async () => {
  const store = new SocialStore(':memory:');
  const w = harness(store, fakeWorlds());
  const alice = w.add('alice', 'Alice');
  w.social.onJoin(alice);
  for (const n of ['b', 'c', 'd', 'e', 'f', 'g', 'h']) {
    const p = w.add(n, n.toUpperCase());
    w.social.onJoin(p);
    assert.equal(w.social.partyInvite(alice, n), 'ok', `invite ${n}`);
    assert.equal(w.social.partyAccept(p, 'alice'), 'ok', `accept ${n}`);
  }
  assert.equal(w.social.partyMembersOf('alice').length, 8);

  const ninth = w.add('i', 'I');
  w.social.onJoin(ninth);
  assert.equal(w.social.partyInvite(alice, 'i'), 'party_full');
  w.close();
  store.close();
});
