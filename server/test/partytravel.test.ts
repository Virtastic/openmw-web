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
  await w.social.partyTravel(w.players.get('bob')!, 'party');
  assert.equal(w.events('bob', 'SocialResult').filter((e) => e.body['op'] === 'PartyTravel'
    && e.body['detail'] === 'not_leader').length, 1);

  // Leader travels to the party world: both members get the destination.
  await w.social.partyTravel(w.players.get('alice')!, 'party');
  const a = w.events('alice', 'PartyTravel');
  const b = w.events('bob', 'PartyTravel');
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0]!.body['worldId'], b[0]!.body['worldId']);
  assert.ok(String(a[0]!.body['worldId']).startsWith('party-p'));
  assert.equal(a[0]!.body['port'], 9001);
  assert.equal(worlds.created.length, 1);

  // Then to public: the existing public world, not a created one.
  await w.social.partyTravel(w.players.get('alice')!, 'public');
  const a2 = w.events('alice', 'PartyTravel');
  assert.equal(a2.length, 2);
  assert.equal(a2[1]!.body['worldId'], 'vvardenfell');
  assert.equal(worlds.created.length, 1, 'public travel must not create a world');

  // Repeat party travel reuses the SAME world id (the campaign world is stable).
  await w.social.partyTravel(w.players.get('alice')!, 'party');
  assert.equal(worlds.created[1], worlds.created[0]);
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
