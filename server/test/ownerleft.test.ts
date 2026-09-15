// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// A GUEST WORLD WITH NO HOST CLOSES — after a grace.
//
// A host who crashes or reloads should come back to their guests, not to an empty world: the
// guests keep playing through the grace window, and the world closes only if the owner does
// not return before it expires.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';
import { SocialStore } from '../src/core/socialstore';

test('the owner leaving closes the world to its guests', async (t) => {
  const dataDir = tmpDataDir();
  // mayJoinWorld admits the OWNER'S FRIENDS — so the fixture needs real friendships.
  // Written before the server opens the store.
  const social = new SocialStore(dataDir);
  social.addFriend('host', 'guest', Date.now());
  social.addFriend('host', 'tourist', Date.now());
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    worldMode: 'party', worldOwner: 'host', ownerGraceMs: 700,
    configOverride: { login: { allowHarnessAuth: true } } as never,
  });
  t.after(() => server.close());

  const owner = await TestClient.connect(server.port);
  await owner.joinAsNew('Host', 'hunter22');
  await owner.waitEvent('PlayerList');

  const guest = await TestClient.connect(server.port);
  t.after(() => guest.close());
  await guest.joinAsNew('Guest', 'hunter22');
  await guest.waitEvent('PlayerList');

  // The host closes their tab. The world does NOT close immediately — the guest plays on
  // through the grace window — and then closes when the host does not return.
  owner.close();
  await owner.closed;

  const early = await Promise.race([
    guest.waitEvent('WorldClosed', () => true, 300).then(() => 'closed', () => 'open'),
    new Promise((r) => setTimeout(() => r('open'), 400)),
  ]);
  assert.equal(early, 'open', 'the world closed inside the grace window');

  const closed = await guest.waitEvent('WorldClosed', () => true, 8000);
  assert.equal((closed.value as { reason?: string }).reason, 'owner_left',
    'the guest was never told the world lost its host');
});

test('the owner returning inside the grace keeps the world open', async (t) => {
  const dataDir = tmpDataDir();
  const social = new SocialStore(dataDir);
  social.addFriend('host', 'guest', Date.now());
  social.close();
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    worldMode: 'party', worldOwner: 'host', ownerGraceMs: 900,
    configOverride: { login: { allowHarnessAuth: true } } as never,
  });
  t.after(() => server.close());

  const owner = await TestClient.connect(server.port);
  await owner.joinAsNew('Host', 'hunter22');
  await owner.waitEvent('PlayerList');
  const guest = await TestClient.connect(server.port);
  t.after(() => guest.close());
  await guest.joinAsNew('Guest', 'hunter22');
  await guest.waitEvent('PlayerList');

  owner.close();
  await owner.closed;

  // The host comes back before the grace expires.
  const back = await TestClient.connect(server.port);
  t.after(() => back.close());
  await back.joinExisting('Host', 'hunter22');

  const got = await Promise.race([
    guest.waitEvent('WorldClosed', () => true, 1500).then(() => 'closed', () => 'open'),
    new Promise((r) => setTimeout(() => r('open'), 1800)),
  ]);
  assert.equal(got, 'open', 'the world closed even though the host returned in time');
});

test('a guest leaving closes nothing', async (t) => {
  const dataDir = tmpDataDir();
  // mayJoinWorld admits the OWNER'S FRIENDS.
  const social = new SocialStore(dataDir);
  social.addFriend('host', 'guest', Date.now());
  social.addFriend('host', 'tourist', Date.now());
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    worldMode: 'party', worldOwner: 'host',
    configOverride: { login: { allowHarnessAuth: true } } as never,
  });
  t.after(() => server.close());

  const owner = await TestClient.connect(server.port);
  t.after(() => owner.close());
  await owner.joinAsNew('Host', 'hunter22');
  await owner.waitEvent('PlayerList');

  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Tourist', 'hunter22');
  await a.waitEvent('PlayerList');
  a.close();
  await a.closed;

  // The host is still here, so the world stays open.
  const got = await Promise.race([
    // A timeout REJECTS, which would reject the race rather than meaning "nothing came".
    owner.waitEvent('WorldClosed', () => true, 1500).then(() => 'closed', () => 'open'),
    new Promise((r) => setTimeout(() => r('open'), 1800)),
  ]);
  assert.equal(got, 'open', 'a guest leaving closed the host out of their own world');
});

// A HOST ALONE WHO BLIPS KEEPS PARTY. Both cleanup callbacks fired on the same disconnect:
// the grace was armed and, one line later, the world-empty revert put the mode back to
// Solo -- so a host who reloaded before their friend arrived came back to Solo with no
// notice, and the friend's Join answered "this world is private". The grace owns the revert.
test('a host alone who reloads inside the grace comes back to a Party world', async (t) => {
  const dataDir = tmpDataDir();
  const social = new SocialStore(dataDir);
  social.addFriend('host', 'guest', Date.now());
  social.close();
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    worldMode: 'party', worldOwner: 'host', ownerGraceMs: 900,
    configOverride: { login: { allowHarnessAuth: true } } as never,
  });
  t.after(() => server.close());
  let owner = await TestClient.connect(server.port);
  await owner.joinAsNew('Host', 'hunter22');
  await owner.waitEvent('PlayerList');
  owner.close();
  await owner.closed; // alone: the world is now EMPTY, inside the grace

  owner = await TestClient.connect(server.port);
  await owner.joinExisting('Host');
  const mode = (await owner.waitEvent('WorldMode')).value as { mode?: string };
  assert.equal(mode.mode, 'party', 'the host came back to a Solo world');
  // ...and the friend can still come in.
  const guest = await TestClient.connect(server.port);
  t.after(() => { owner.close(); guest.close(); });
  await guest.joinAsNew('Guest', 'hunter22');
  await guest.waitEvent('PlayerList');
});

// #29: THE HOST WHO CAME BACK TOO LATE is told who was sent home -- once, on their first
// WorldMode after the return, and the WorldMode carries the timeSkip rule (#262).
test('a host returning after the grace hears which guests were sent home', async (t) => {
  const dataDir = tmpDataDir();
  const social = new SocialStore(dataDir);
  social.addFriend('host', 'guest', Date.now());
  social.close();
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    worldMode: 'party', worldOwner: 'host', ownerGraceMs: 500,
    configOverride: { login: { allowHarnessAuth: true } } as never,
  });
  t.after(() => server.close());
  let owner = await TestClient.connect(server.port);
  await owner.joinAsNew('Host', 'hunter22');
  const first = (await owner.waitEvent('WorldMode')).value as { timeSkip?: string; sentHome?: string[] };
  assert.equal(first.timeSkip, 'owner', 'the rest rule rides WorldMode');
  assert.equal(first.sentHome, undefined, 'nothing to report on a first join');
  const guest = await TestClient.connect(server.port);
  t.after(() => guest.close());
  await guest.joinAsNew('Guest', 'hunter22');
  await guest.waitEvent('PlayerList');
  owner.close();
  await owner.closed;
  await guest.waitEvent('WorldClosed', () => true, 8000); // the grace ran out

  owner = await TestClient.connect(server.port);
  await owner.joinExisting('Host');
  const back = (await owner.waitEvent('WorldMode')).value as { mode?: string; sentHome?: string[] };
  assert.equal(back.mode, 'private');
  assert.deepEqual(back.sentHome, ['Guest'], 'the returning host was not told who went home');
  owner.close();
  await owner.closed;

  owner = await TestClient.connect(server.port);
  t.after(() => owner.close());
  await owner.joinExisting('Host');
  const again = (await owner.waitEvent('WorldMode')).value as { sentHome?: string[] };
  assert.equal(again.sentHome, undefined, 'the notice repeated on a later join');
});

// A DELIBERATE EXIT IS NOT A CRASH. Exit, a character switch, "join a friend": the client
// says PlayerLeaving and the world closes to guests now, not ninety seconds later -- and in
// the meantime nobody new is admitted into a world with no host in it.
test('a host who leaves on purpose closes the world at once; a hostless world admits nobody', async (t) => {
  const dataDir = tmpDataDir();
  const social = new SocialStore(dataDir);
  social.addFriend('host', 'guest', Date.now());
  social.addFriend('host', 'late', Date.now());
  social.close();
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    worldMode: 'party', worldOwner: 'host', ownerGraceMs: 60_000,
    configOverride: { login: { allowHarnessAuth: true } } as never,
  });
  t.after(() => server.close());
  const owner = await TestClient.connect(server.port);
  await owner.joinAsNew('Host', 'hunter22');
  await owner.waitEvent('PlayerList');
  const guest = await TestClient.connect(server.port);
  t.after(() => guest.close());
  await guest.joinAsNew('Guest', 'hunter22');
  await guest.waitEvent('PlayerList');

  // First, a crash: the host drops without a word. The grace runs (60 s); during it a
  // newcomer must NOT be admitted into a world with nobody to visit.
  owner.close();
  await owner.closed;
  const late = await TestClient.connect(server.port);
  late.hello();
  await late.waitJson('SessionHelloOk');
  late.login('Late', 'hunter22');
  await late.waitDisconnect('AUTH_FAILED');
  // The host comes back inside the grace, then leaves ON PURPOSE: closed at once.
  const back = await TestClient.connect(server.port);
  await back.joinExisting('Host');
  await back.waitEvent('PlayerList');
  back.sendEvent('PlayerLeaving', {});
  const closed = await guest.waitEvent('WorldClosed', () => true, 3000);
  assert.equal((closed.value as { reason?: string }).reason, 'owner_left', 'a deliberate exit must close the world now, not after the grace');
  back.close();
});

// A RETURNING GUEST IS NOT A NEWCOMER (backlog 352). The no-host-no-newcomers rule in
// mayJoinWorld applied to a resume too, so a shared wifi blip that dropped both -- and let
// the guest's reconnect beat the host's -- sent the guest home "this world is private" from
// a world that was about to reopen.
test('a guest resuming inside the host grace is admitted', async (t) => {
  const dataDir = tmpDataDir();
  const social = new SocialStore(dataDir);
  social.addFriend('host', 'guest', Date.now());
  social.close();
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    worldMode: 'party', worldOwner: 'host', ownerGraceMs: 5000,
    configOverride: { login: { allowHarnessAuth: true } } as never,
  });
  t.after(() => server.close());

  const owner = await TestClient.connect(server.port);
  await owner.joinAsNew('Host', 'hunter22');
  await owner.waitEvent('PlayerList');
  const guest = await TestClient.connect(server.port);
  const { welcome } = await guest.joinAsNew('Guest', 'hunter22');
  await guest.waitEvent('PlayerList');
  const token = welcome['sessionToken'] as string;

  // Both drop; the guest's redial arrives first, while the grace runs.
  owner.close();
  await owner.closed;
  guest.close();
  await guest.closed;

  const back = await TestClient.connect(server.port);
  t.after(() => back.close());
  back.hello();
  await back.waitJson('SessionHelloOk');
  back.sendJson({ t: 'SessionResume', token });
  await back.waitJson('SessionWelcome');
});
