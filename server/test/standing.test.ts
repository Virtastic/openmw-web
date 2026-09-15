// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Standing has to make the ROUND TRIP, and for a long time it only made half of it: faction
// rank/reputation/expulsion and crime bounty were written to the character doc and never read
// back by anything, so "your standing follows you" was true on the way out and false on the
// way in. The client now applies them from playerRecord (quests.restoreStanding).
//
// The server half asserted here is the other requirement: standing is routed like the journal,
// so a shared world — which resets, and persists no campaign progress — cannot hand out guild
// ranks or bounties that follow a visitor home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir, readPlayerDoc } from './helpers';

async function ownWorld(dataDir: string) {
  return startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: 'private',
    configOverride: { login: { allowHarnessAuth: true } } as never,
  });
}

test('standing earned in your own world is recorded and sent back on the next join', async (t) => {
  const dataDir = tmpDataDir();
  const solo = await ownWorld(dataDir);
  const a = await TestClient.connect(solo.port);
  const { welcome } = await a.joinAsNew('Ranker', 'hunter22');
  const charId = String(welcome['characterId']);
  await a.waitEvent('PlayerList');
  a.sendEvent('PlayerAppearance', {
    race: 'dark elf', head: 'h', hair: 'x', isMale: true, class: 'nightblade', name: 'Ranker',
  });
  a.sendEvent('ChargenComplete', {});
  a.sendEvent('FactionUpdate', { factionId: 'fightersguild', rank: 3, reputation: 12 });
  a.sendEvent('CrimeUpdate', { bounty: 250 });
  a.close();
  await a.closed;
  await solo.flush();
  await solo.close();

  const doc = readPlayerDoc(dataDir, charId);
  assert.deepEqual((doc?.['factions'] as Record<string, unknown>)?.['fightersguild'],
    { rank: 3, reputation: 12 }, 'the rank was not recorded');
  assert.equal(doc?.['bounty'], 250, 'the bounty was not recorded');

  // ...and comes back. playerRecord is the whole doc, which is what the client restores from.
  const solo2 = await ownWorld(dataDir);
  t.after(() => solo2.close());
  const b = await TestClient.connect(solo2.port);
  t.after(() => b.close());
  const w2 = await b.joinExisting('Ranker');
  const record = w2['playerRecord'] as Record<string, unknown> | null;
  assert.ok(record, 'no playerRecord: there is nothing for the client to restore from');
  assert.deepEqual((record?.['factions'] as Record<string, unknown>)?.['fightersguild'],
    { rank: 3, reputation: 12 }, 'standing was not sent back to the client');
  assert.equal(record?.['bounty'], 250);
});


// A GUEST'S BOUNTY IS THE WORLD'S, NOT THEIR OWN DOC'S. The peer's guards read the world's
// number (the host's record when crime is personal); the client restored the doc's. A guest
// wanted at home was offered pay-or-jail by every guard in the host's world while the peer's
// guards ignored them. With crime SHARED (one record for the party; personal is the default
// since backlog 353) the guest's own crime here is the party's: it lands on the host's
// campaign and every avatar is wanted.
test("a guest's welcome carries the host world's bounty; their crime is the party's", async (t) => {
  const { SocialStore } = await import('../src/core/socialstore');
  const dataDir = tmpDataDir();
  new SocialStore(dataDir).addFriend('host', 'guest', Date.now());
  const sharedCrime = { login: { allowHarnessAuth: true }, sharing: { crime: true } } as never;
  // The guest has a record at home: wanted for 500.
  const home = await startServer({ requireGameData: false, dataDir: tmpDataDir(), sharedDir: dataDir, port: 0, host: '127.0.0.1', worldMode: 'private', worldOwner: 'guest', worldId: 'priv-guest', configOverride: sharedCrime });
  const g0 = await TestClient.connect(home.port);
  await g0.joinAsNew('Guest', 'hunter22');
  await g0.waitEvent('PlayerList');
  g0.sendEvent('PlayerAppearance', { race: 'dark elf', head: 'h', hair: 'x', isMale: true, class: 'nightblade', name: 'Guest' });
  g0.sendEvent('ChargenComplete', {});
  g0.sendEvent('CrimeUpdate', { bounty: 500 });
  g0.close(); await g0.closed; await home.flush(); await home.close();

  const world = await startServer({ requireGameData: false, dataDir: tmpDataDir(), sharedDir: dataDir, port: 0, host: '127.0.0.1', worldMode: 'party', worldOwner: 'host', worldId: 'priv-host', configOverride: sharedCrime });
  t.after(() => world.close());
  const host = await TestClient.connect(world.port);
  t.after(() => host.close());
  const hw = await host.joinAsNew('Host', 'hunter22');
  const hostChar = String(hw.welcome['characterId']);
  await host.waitEvent('PlayerList');
  host.sendEvent('PlayerAppearance', { race: 'dark elf', head: 'h', hair: 'x', isMale: true, class: 'nightblade', name: 'Host' });
  host.sendEvent('ChargenComplete', {});
  const guest = await TestClient.connect(world.port);
  t.after(() => guest.close());
  const gw = await guest.joinExisting('Guest', 'hunter22');
  const record = gw['playerRecord'] as Record<string, unknown> | null;
  assert.ok(record, 'the guest has a record');
  assert.equal(record?.['bounty'], 0, "the guest's welcome carries the host world's bounty (clean), not their own 500");
  await guest.waitEvent('PlayerList');
  guest.sendEvent('CrimeUpdate', { bounty: 300 });
  const seen = (await host.waitEvent('CrimeUpdate', (v) => (v as { shared?: boolean }).shared === true)).value as { bounty: number };
  assert.equal(seen.bounty, 300, 'shared crime: the host is wanted for it too');
  await world.flush();
  assert.equal(readPlayerDoc(dataDir, hostChar)?.['bounty'], 300, "shared crime is the campaign's record");
});

const chargen = (c: TestClient, name: string) => {
  c.sendEvent('PlayerAppearance', { race: 'dark elf', head: 'h', hair: 'x', isMale: true, class: 'nightblade', name });
  c.sendEvent('ChargenComplete', {});
};

// Backlog 141: with factions SHARED the guest's rank is the campaign's -- the host's doc
// seeds it and a rank the guest earns here is written to that doc and shared.factions --
// but the welcome record came from the guest's own doc, so they arrived with home ranks and
// a relog lost what they earned here.
test("a guest's welcome carries the host campaign's faction ranks, including one the guest earned", async (t) => {
  const { SocialStore } = await import('../src/core/socialstore');
  const dataDir = tmpDataDir();
  new SocialStore(dataDir).addFriend('host', 'guest', Date.now());
  const home = await startServer({ requireGameData: false, dataDir: tmpDataDir(), sharedDir: dataDir, port: 0, host: '127.0.0.1', worldMode: 'private', worldOwner: 'guest', worldId: 'priv-guest', configOverride: { login: { allowHarnessAuth: true } } as never });
  const g0 = await TestClient.connect(home.port);
  await g0.joinAsNew('Guest', 'hunter22');
  await g0.waitEvent('PlayerList');
  chargen(g0, 'Guest');
  g0.sendEvent('FactionUpdate', { factionId: 'thievesguild', rank: 5 }); // home rank: must not travel
  g0.close(); await g0.closed; await home.flush(); await home.close();

  const world = await startServer({ requireGameData: false, dataDir: tmpDataDir(), sharedDir: dataDir, port: 0, host: '127.0.0.1', worldMode: 'party', worldOwner: 'host', worldId: 'priv-host', configOverride: { login: { allowHarnessAuth: true } } as never });
  t.after(() => world.close());
  const host = await TestClient.connect(world.port);
  t.after(() => host.close());
  await host.joinAsNew('Host', 'hunter22');
  await host.waitEvent('PlayerList');
  chargen(host, 'Host');
  host.sendEvent('FactionUpdate', { factionId: 'fightersguild', rank: 3, reputation: 12 });
  await world.flush();

  const guest = await TestClient.connect(world.port);
  const gw = await guest.joinExisting('Guest', 'hunter22');
  const factions = (gw['playerRecord'] as Record<string, unknown>)['factions'] as Record<string, unknown>;
  assert.deepEqual(factions['fightersguild'], { rank: 3, reputation: 12 }, "the host's rank did not reach the guest's welcome");
  assert.equal(factions['thievesguild'], undefined, 'a home rank travelled into the visit');
  await guest.waitEvent('PlayerList');
  guest.sendEvent('FactionUpdate', { factionId: 'magesguild', rank: 1 });
  await host.waitEvent('FactionUpdate');
  guest.close(); await guest.closed;

  const again = await TestClient.connect(world.port);
  t.after(() => again.close());
  const gw2 = await again.joinExisting('Guest', 'hunter22');
  const f2 = (gw2['playerRecord'] as Record<string, unknown>)['factions'] as Record<string, unknown>;
  assert.deepEqual(f2['magesguild'], { rank: 1 }, 'the rank the guest earned here was lost on relog');
});

// Backlog 147: with crime PERSONAL the guest is held to their own number, not the host's.
test("personal crime: a guest's welcome carries their own bounty, not the host's", async (t) => {
  const { SocialStore } = await import('../src/core/socialstore');
  const dataDir = tmpDataDir();
  new SocialStore(dataDir).addFriend('host', 'guest', Date.now());
  const personal = { login: { allowHarnessAuth: true }, sharing: { crime: false } } as never;
  const home = await startServer({ requireGameData: false, dataDir: tmpDataDir(), sharedDir: dataDir, port: 0, host: '127.0.0.1', worldMode: 'private', worldOwner: 'guest', worldId: 'priv-guest', configOverride: personal });
  const g0 = await TestClient.connect(home.port);
  await g0.joinAsNew('Guest', 'hunter22');
  await g0.waitEvent('PlayerList');
  chargen(g0, 'Guest');
  g0.sendEvent('CrimeUpdate', { bounty: 500 });
  g0.close(); await g0.closed; await home.flush(); await home.close();

  const world = await startServer({ requireGameData: false, dataDir: tmpDataDir(), sharedDir: dataDir, port: 0, host: '127.0.0.1', worldMode: 'party', worldOwner: 'host', worldId: 'priv-host', configOverride: personal });
  t.after(() => world.close());
  const host = await TestClient.connect(world.port);
  t.after(() => host.close());
  await host.joinAsNew('Host', 'hunter22');
  await host.waitEvent('PlayerList');
  chargen(host, 'Host');
  host.sendEvent('CrimeUpdate', { bounty: 400 });
  await world.flush();
  const guest = await TestClient.connect(world.port);
  t.after(() => guest.close());
  const gw = await guest.joinExisting('Guest', 'hunter22');
  assert.equal((gw['playerRecord'] as Record<string, unknown>)['bounty'], 500, "personal crime seeded the guest with the host's 400");
});

// Backlog 353: with crime PERSONAL (the default) a guest's bounty is THEIR OWN record -- written
// to their own doc, never the host's, and back on their next welcome. It used to be persisted
// nowhere, so a guest who stole and relogged came back clean.
test("personal crime: a guest's bounty lands on their own doc, not the host's, and survives a relog", async (t) => {
  const { SocialStore } = await import('../src/core/socialstore');
  const dataDir = tmpDataDir();
  new SocialStore(dataDir).addFriend('host', 'guest', Date.now());
  const opts = { login: { allowHarnessAuth: true } } as never;
  const home = await startServer({ requireGameData: false, dataDir: tmpDataDir(), sharedDir: dataDir, port: 0, host: '127.0.0.1', worldMode: 'private', worldOwner: 'guest', worldId: 'priv-guest', configOverride: opts });
  const g0 = await TestClient.connect(home.port);
  const g0w = await g0.joinAsNew('Guest', 'hunter22');
  const guestChar = String(g0w.welcome['characterId']);
  await g0.waitEvent('PlayerList');
  chargen(g0, 'Guest');
  g0.close(); await g0.closed; await home.flush(); await home.close();

  const world = await startServer({ requireGameData: false, dataDir: tmpDataDir(), sharedDir: dataDir, port: 0, host: '127.0.0.1', worldMode: 'party', worldOwner: 'host', worldId: 'priv-host', configOverride: opts });
  t.after(() => world.close());
  const host = await TestClient.connect(world.port);
  t.after(() => host.close());
  const hw = await host.joinAsNew('Host', 'hunter22');
  const hostChar = String(hw.welcome['characterId']);
  await host.waitEvent('PlayerList');
  chargen(host, 'Host');
  const guest = await TestClient.connect(world.port);
  await guest.joinExisting('Guest', 'hunter22');
  await guest.waitEvent('PlayerList');
  guest.sendEvent('CrimeUpdate', { bounty: 300, kind: 'theft' });
  guest.close(); await guest.closed;
  await world.flush();
  assert.equal(readPlayerDoc(dataDir, guestChar)?.['bounty'], 300, "the guest's own record");
  assert.notEqual(readPlayerDoc(dataDir, hostChar)?.['bounty'], 300, 'the host inherited a guest\'s theft');

  const back = await TestClient.connect(world.port);
  t.after(() => back.close());
  const bw = await back.joinExisting('Guest', 'hunter22');
  assert.equal((bw['playerRecord'] as Record<string, unknown>)['bounty'], 300, 'the relog came back clean');
});

// Backlog 215: the peer's idle dummy runs the OnDeath scripts (PCRaiseRank after Bolvyn,
// Trebonius, Eno Hlaalu) and reported a FactionUpdate that landed on the HOST's campaign doc
// -- a demotion when factions are not shared. A system peer has no standing to write.
test("a system peer's FactionUpdate does not touch the campaign doc", async (t) => {
  const dataDir = tmpDataDir();
  const solo = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: 'private',
    configOverride: { login: { allowHarnessAuth: true }, server: { password: 'peer-secret-1' } } as never,
  });
  t.after(() => solo.close());
  const a = await TestClient.connect(solo.port);
  const { welcome } = await a.joinAsNew('Ranker', 'hunter22');
  const charId = String(welcome['characterId']);
  await a.waitEvent('PlayerList');
  chargen(a, 'Ranker');
  a.sendEvent('FactionUpdate', { factionId: 'fightersguild', rank: 3 });
  await solo.flush();
  const peer = await TestClient.simPeer(solo.port, 'peer-secret-1');
  peer.sendEvent('FactionUpdate', { factionId: 'fightersguild', rank: 0 }); // the dummy's OnDeath script
  peer.sendEvent('FactionUpdate', { factionId: 'morag tong', rank: 1 });
  await new Promise((r) => setTimeout(r, 200));
  peer.close(); a.close(); await a.closed; await solo.flush(); await solo.close();
  const factions = readPlayerDoc(dataDir, charId)?.['factions'] as Record<string, unknown>;
  assert.deepEqual(factions['fightersguild'], { rank: 3 }, "the peer's write demoted the host");
  assert.equal(factions['morag tong'], undefined, "the peer's write ranked the host");
});

// Backlog 319: with factions NOT shared a guest's rank is their own. The write still went
// through journalTarget (the HOST's doc) before the isShared check, so a guest's guild rank
// overwrote the host's and the host logged in demoted.
test("with factions off, a guest's rank lands on the guest's doc, not the host's", async (t) => {
  const { SocialStore } = await import('../src/core/socialstore');
  const dataDir = tmpDataDir();
  new SocialStore(dataDir).addFriend('host', 'guest', Date.now());
  const off = { login: { allowHarnessAuth: true }, sharing: { factions: false } } as never;
  const world = await startServer({ requireGameData: false, dataDir: tmpDataDir(), sharedDir: dataDir, port: 0, host: '127.0.0.1', worldMode: 'party', worldOwner: 'host', worldId: 'priv-host', configOverride: off });
  t.after(() => world.close());
  const host = await TestClient.connect(world.port);
  t.after(() => host.close());
  const hostChar = String((await host.joinAsNew('Host', 'hunter22')).welcome['characterId']);
  await host.waitEvent('PlayerList');
  chargen(host, 'Host');
  host.sendEvent('FactionUpdate', { factionId: 'fightersguild', rank: 3 });

  const guest = await TestClient.connect(world.port);
  t.after(() => guest.close());
  const guestChar = String((await guest.joinAsNew('Guest', 'hunter22')).welcome['characterId']);
  await guest.waitEvent('PlayerList');
  chargen(guest, 'Guest');
  guest.sendEvent('FactionUpdate', { factionId: 'fightersguild', rank: 1 });
  await new Promise((r) => setTimeout(r, 100));
  await world.flush();

  const h = readPlayerDoc(dataDir, hostChar)?.['factions'] as Record<string, unknown>;
  const g = readPlayerDoc(dataDir, guestChar)?.['factions'] as Record<string, unknown>;
  assert.deepEqual(h['fightersguild'], { rank: 3 }, "the guest's rank demoted the host");
  assert.deepEqual(g['fightersguild'], { rank: 1 }, "the guest's own rank was not recorded");
});
