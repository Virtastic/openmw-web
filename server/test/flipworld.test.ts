// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Flip-in-place: a character's Solo world becomes their Party world WITHOUT respawning it or
// moving the owner — the owner flips it and it starts admitting their friends. Only the
// owner (or an admin) may flip.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { SocialStore } from '../src/core/socialstore';
import { TestClient, tmpDataDir } from './helpers';

test('owner flips private->party in place; their friend is then admitted; a guest cannot flip', async (t) => {
  const shared = tmpDataDir();
  const pub = await startServer({ requireGameData: false, dataDir: tmpDataDir(), sharedDir: shared, port: 0, host: '127.0.0.1' });
  t.after(() => pub.close());
  for (const name of ['Alice', 'Bob']) {
    const c = await TestClient.connect(pub.port);
    await c.joinAsNew(name);
    c.close();
  }
  await pub.flush();

  // Bob is Alice's friend — the same store the world consults for "who may join".
  const store = new SocialStore(shared);
  store.addFriend('alice', 'bob', Date.now());
  store.close();

  // Alice's PRIVATE world (her solo instance). Owner = alice.
  const world = await startServer({ requireGameData: false,
    dataDir: tmpDataDir(), sharedDir: shared, port: 0, host: '127.0.0.1',
    worldId: 'priv-alice', worldMode: 'private', worldOwner: 'alice',
  });
  t.after(() => world.close());

  const alice = await TestClient.connect(world.port);
  await alice.joinExisting('Alice'); // owner: welcome

  // While private, Bob (a friend) is still refused — private is solo.
  const bob1 = await TestClient.connect(world.port);
  bob1.hello();
  await bob1.waitJson('SessionHelloOk');
  bob1.login('Bob', 'hunter22');
  const refusal = await bob1.waitDisconnect('AUTH_FAILED');
  assert.match(String(refusal['detail']), /private/i);

  // Alice flips HER world to party — in place, she does not move.
  alice.sendEvent('SetWorldMode', { mode: 'party' });
  await alice.waitEvent('SocialResult',
    (v) => (v as { op?: string; ok?: boolean }).op === 'SetWorldMode' && (v as { ok?: boolean }).ok === true);

  // Now Bob is admitted to Alice's (formerly private) world.
  const bob2 = await TestClient.connect(world.port);
  await bob2.joinExisting('Bob');

  // A non-owner guest cannot flip the world.
  bob2.sendEvent('SetWorldMode', { mode: 'private' });
  const denied = await bob2.waitEvent('SocialResult', (v) => (v as { op?: string }).op === 'SetWorldMode');
  assert.equal((denied.value as { ok?: boolean }).ok, false);
  assert.equal((denied.value as { detail?: string }).detail, 'not_owner');

  bob2.close();
  alice.close();
});

test('a world you do not own is not flippable', async (t) => {
  // A standalone world has no owner, so no ordinary player may flip it.
  const pub = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1' });
  t.after(() => pub.close());
  const c = await TestClient.connect(pub.port);
  await c.joinAsNew('Zoe');
  c.sendEvent('SetWorldMode', { mode: 'party' });
  const r = await c.waitEvent('SocialResult', (v) => (v as { op?: string }).op === 'SetWorldMode');
  assert.equal((r.value as { ok?: boolean }).ok, false);
  assert.equal((r.value as { detail?: string }).detail, 'not_owner');
  c.close();
});

// Closing your world means closing it. mayJoinWorld only gates ARRIVAL, so flipping back to
// Solo used to leave every guest standing inside a world that had just stopped admitting
// them.
test('flipping back to Solo evicts the guests who are already inside', async (t) => {
  const shared = tmpDataDir();
  const pub = await startServer({ requireGameData: false, dataDir: tmpDataDir(), sharedDir: shared, port: 0, host: '127.0.0.1' });
  t.after(() => pub.close());
  for (const name of ['Ada', 'Ben']) {
    const c = await TestClient.connect(pub.port);
    await c.joinAsNew(name);
    c.close();
  }
  await pub.flush();

  const store = new SocialStore(shared);
  store.addFriend('ada', 'ben', Date.now());
  store.close();

  const world = await startServer({ requireGameData: false,
    dataDir: tmpDataDir(), sharedDir: shared, port: 0, host: '127.0.0.1',
    worldId: 'priv-ada', worldMode: 'party', worldOwner: 'ada',
  });
  t.after(() => world.close());

  const ada = await TestClient.connect(world.port);
  await ada.joinExisting('Ada');
  const ben = await TestClient.connect(world.port);
  await ben.joinExisting('Ben');

  ada.sendEvent('SetWorldMode', { mode: 'private' });
  await ada.waitEvent('SocialResult',
    (v) => (v as { op?: string; ok?: boolean }).op === 'SetWorldMode' && (v as { ok?: boolean }).ok === true);

  // The guest is told to go home. The owner is not.
  const closed = await ben.waitEvent('WorldClosed', () => true, 5000);
  assert.equal((closed.value as { reason?: string }).reason, 'owner_went_solo');

  ben.close();
  ada.close();
});

// THE DOOR CLOSES BEHIND YOU TOO. The friends list is the only way into a party world, but it
// was checked at the door only: a guest the host had just BLOCKED stayed in the host's world,
// seeing and hearing everything, until the host went solo and threw out everyone. Ending the
// friendship -- unfriend or block, from either side -- must send that one guest home and
// leave the rest of the party alone.
test('unfriending or blocking a guest sends them home; the other guest stays', async (t) => {
  const shared = tmpDataDir();
  const pub = await startServer({ requireGameData: false, dataDir: tmpDataDir(), sharedDir: shared, port: 0, host: '127.0.0.1' });
  t.after(() => pub.close());
  for (const name of ['Host', 'Pest', 'Pal']) {
    const c = await TestClient.connect(pub.port);
    await c.joinAsNew(name);
    c.close();
    await c.closed;
  }
  await pub.flush();
  const store = new SocialStore(shared);
  store.addFriend('host', 'pest', Date.now());
  store.addFriend('host', 'pal', Date.now());
  store.close();

  const world = await startServer({ requireGameData: false,
    dataDir: tmpDataDir(), sharedDir: shared, port: 0, host: '127.0.0.1',
    worldId: 'priv-host', worldMode: 'party', worldOwner: 'host', guestKickGraceMs: 500,
  });
  t.after(() => world.close());
  const host = await TestClient.connect(world.port);
  await host.joinExisting('Host');
  const pest = await TestClient.connect(world.port);
  await pest.joinExisting('Pest');
  const pal = await TestClient.connect(world.port);
  await pal.joinExisting('Pal');
  t.after(() => { host.close(); pal.close(); });

  // The host blocks Pest: Pest is told to go home, and then dropped; Pal is untouched.
  host.sendEvent('BlockAdd', { name: 'Pest' });
  const closed = (await pest.waitEvent('WorldClosed')).value as { reason?: string; by?: string };
  assert.equal(closed.reason, 'unfriended');
  assert.equal(closed.by, 'Host', 'the notice names the owner by character name');
  await pest.waitDisconnect('KICKED');
  assert.equal(pal.inbox.events.filter((e) => e.name === 'WorldClosed').length, 0, 'the other guest must not be sent home');
  assert.equal(host.inbox.events.filter((e) => e.name === 'WorldClosed').length, 0, 'the owner never moves');

  // ...and the door stays shut: Pest cannot come back in.
  const again = await TestClient.connect(world.port);
  again.hello();
  await again.waitJson('SessionHelloOk');
  again.login('Pest', 'hunter22');
  await again.waitDisconnect('AUTH_FAILED');
});

test('a guest who unfriends the host while visiting goes home; the host stays put', async (t) => {
  const shared = tmpDataDir();
  const pub = await startServer({ requireGameData: false, dataDir: tmpDataDir(), sharedDir: shared, port: 0, host: '127.0.0.1' });
  t.after(() => pub.close());
  for (const name of ['Host', 'Leaver']) {
    const c = await TestClient.connect(pub.port);
    await c.joinAsNew(name);
    c.close();
    await c.closed;
  }
  await pub.flush();
  const store = new SocialStore(shared);
  store.addFriend('host', 'leaver', Date.now());
  store.close();
  const world = await startServer({ requireGameData: false,
    dataDir: tmpDataDir(), sharedDir: shared, port: 0, host: '127.0.0.1',
    worldId: 'priv-host', worldMode: 'party', worldOwner: 'host', guestKickGraceMs: 500,
  });
  t.after(() => world.close());
  const host = await TestClient.connect(world.port);
  await host.joinExisting('Host');
  const leaver = await TestClient.connect(world.port);
  await leaver.joinExisting('Leaver');
  t.after(() => host.close());

  leaver.sendEvent('FriendRemove', { acct: 'host' });
  const closed = (await leaver.waitEvent('WorldClosed')).value as { reason?: string };
  assert.equal(closed.reason, 'unfriended');
  await leaver.waitDisconnect('KICKED');
  assert.equal(host.inbox.events.filter((e) => e.name === 'WorldClosed').length, 0, 'the owner is never evicted from their own world');
});

// THE HOST'S ORDINARY KICK. Every co-op lobby has "remove from party" beside "block". Here the
// only eviction was Solo (everyone out) or block (unfriend forever). WorldKick sends ONE guest
// home, keeps the friendship and the open door: they can come straight back if invited again.
// And WorldMode tells every client whose world it is, so a guest's UI can say "Visiting X".
test('the host sends one guest home without blocking them; a guest cannot kick; WorldMode names the host', async (t) => {
  const shared = tmpDataDir();
  const pub = await startServer({ requireGameData: false, dataDir: tmpDataDir(), sharedDir: shared, port: 0, host: '127.0.0.1' });
  t.after(() => pub.close());
  for (const name of ['Host', 'Guest', 'Pal']) {
    const c = await TestClient.connect(pub.port);
    await c.joinAsNew(name);
    c.close();
    await c.closed;
  }
  await pub.flush();
  const store = new SocialStore(shared);
  store.addFriend('host', 'guest', Date.now());
  store.addFriend('host', 'pal', Date.now());
  store.close();
  const world = await startServer({ requireGameData: false,
    dataDir: tmpDataDir(), sharedDir: shared, port: 0, host: '127.0.0.1',
    worldId: 'priv-host', worldMode: 'party', worldOwner: 'host', guestKickGraceMs: 500,
  });
  t.after(() => world.close());
  const host = await TestClient.connect(world.port);
  await host.joinExisting('Host');
  const guest = await TestClient.connect(world.port);
  await guest.joinExisting('Guest');
  const pal = await TestClient.connect(world.port);
  await pal.joinExisting('Pal');
  t.after(() => { host.close(); pal.close(); });

  // Everyone was told whose world this is at join.
  const hostMode = (await host.waitEvent('WorldMode')).value as { owner?: string; isOwner?: boolean; ownerId?: number };
  assert.equal(hostMode.isOwner, true);
  const guestMode = (await guest.waitEvent('WorldMode')).value as { owner?: string; isOwner?: boolean; ownerId?: number };
  assert.equal(guestMode.isOwner, false);
  assert.equal(guestMode.owner, 'Host', "the guest's client can say whose world it is visiting");
  // The owner's connection id rides too: the sim peer scales levelled lists to the LEADER.
  assert.equal(guestMode.ownerId, 1, 'the peer needs the leader by id (the host joined first: id 1)');

  // A guest cannot kick.
  guest.sendEvent('WorldKick', { name: 'Pal' });
  const denied = (await guest.waitEvent('SocialResult', (v) => (v as { op?: string }).op === 'WorldKick')).value as { ok?: boolean; detail?: string };
  assert.equal(denied.ok, false);
  assert.equal(denied.detail, 'not_owner');

  // The host sends Guest home: told with its own reason, dropped after the grace; Pal stays.
  host.sendEvent('WorldKick', { name: 'Guest' });
  const r = (await host.waitEvent('SocialResult', (v) => (v as { op?: string }).op === 'WorldKick')).value as { ok?: boolean };
  assert.equal(r.ok, true);
  const closed = (await guest.waitEvent('WorldClosed')).value as { reason?: string; by?: string };
  assert.equal(closed.reason, 'kicked');
  assert.equal(closed.by, 'Host');
  await guest.waitDisconnect('KICKED');
  assert.equal(pal.inbox.events.filter((e) => e.name === 'WorldClosed').length, 0, 'the other guest stays');

  // Not a block: still friends. But "send home" STICKS for a while -- without that the guest
  // was back beside the host a minute later from the launcher's "Friends playing now", and
  // the host's only real tool was Block, which also ends the friendship.
  assert.equal(new SocialStore(shared).areFriends('host', 'guest'), true, 'a kick must not end the friendship');
  const back = await TestClient.connect(world.port);
  back.hello();
  await back.waitJson('SessionHelloOk');
  back.login('Guest', 'hunter22');
  await back.waitDisconnect('AUTH_FAILED');
});
