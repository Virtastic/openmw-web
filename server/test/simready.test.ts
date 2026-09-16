// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The client must be told WHEN the world is actually being simulated.
//
// The server hands a player control the moment they join, but the sim peer needs a couple of
// seconds to come up and take their cell (simpeer.ready reports startupMs 1800-3700 on the
// dev box). Move in that gap and the peer arrives, takes authority and asserts its own view
// of the player's position — the rubber-banding on first join — while every actor in the
// cell is puppeted mid-stride and twitches into place.
//
// The old cover for this was an 8s delay on the CLIENT, wrapped around a boot gate, so it
// elapsed before the engine had even connected and covered none of the window. The fix is to
// say so explicitly: SimReady on join with the current answer, and a broadcast the moment it
// becomes true. A clock cannot do this — the wait is a variable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const PASS = 'peer-secret-1';

async function boot(t: { after(fn: () => unknown): void }) {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PASS }, login: { allowHarnessAuth: true } },
  });
  t.after(() => server.close());
  return server;
}

test('a player joining a server with NO peer configured is not held for one', async (t) => {
  const server = await boot(t);

  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  await a.joinAsNew('Solo', 'hunter22');

  const msg = await a.waitEvent('SimReady');
  // [simPeer] is off here (no binary), so nothing will ever simulate: the answer is true and
  // the client plays at once. Pre-fix this said false and a peerless server held every join
  // behind the client's 300 s settle ceiling (#97 lost every no-peer scenario to it).
  assert.equal((msg.value as { ready?: boolean }).ready, true);
});

test('when the peer comes up, everyone already waiting is told', async (t) => {
  const server = await boot(t);

  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  await a.joinAsNew('Waiting', 'hunter22');
  await a.waitEvent('SimReady'); // the join-time answer (true here: no peer configured)

  // The peer arrives. The player is sitting behind a loading screen precisely for this
  // moment — without the push they would sit out the client's timeout instead, which is the
  // same fixed-delay guess by another name.
  const peer = await TestClient.simPeer(server.port, PASS);
  t.after(() => peer.close());

  const ready = await a.waitEvent('SimReady');
  assert.equal((ready.value as { ready?: boolean }).ready, true);
});

test('a player joining an already-simulated world never waits', async (t) => {
  const server = await boot(t);

  const peer = await TestClient.simPeer(server.port, PASS);
  t.after(() => peer.close());

  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Latecomer', 'hunter22');

  // The common case: authority long since established, so the answer is true on arrival and
  // the loading screen never holds at all.
  assert.equal(((await b.waitEvent('SimReady')).value as { ready?: boolean }).ready, true);
});

// Backlog 325: SimReady only ever said true, so a client's peer rules (no fall damage, no
// drowning, no local spawns) stayed pinned for the whole outage. The peer leaving is announced.
test('when the peer goes away, every human is told the world is no longer simulated', async (t) => {
  const server = await boot(t);
  const peer = await TestClient.simPeer(server.port, PASS);
  t.after(() => peer.close());
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  await a.joinAsNew('Insider', 'hunter22');
  assert.equal(((await a.waitEvent('SimReady')).value as { ready?: boolean }).ready, true);
  a.inbox.events.length = 0;

  peer.close();
  const gone = await a.waitEvent('SimReady');
  assert.equal((gone.value as { ready?: boolean }).ready, false, 'the outage is announced');
  // Its return rides the join path ('when the peer comes up, everyone already waiting is told').
});

test('the sim peer is not sent its own readiness', async (t) => {
  const server = await boot(t);
  const peer = await TestClient.simPeer(server.port, PASS);
  t.after(() => peer.close());

  // It is the thing being announced; telling it about itself would have it hold a loading
  // screen it does not have, and it is excluded from every other human-facing broadcast.
  const got = await Promise.race([
    peer.waitEvent('SimReady').then(() => 'sent'),
    new Promise((r) => setTimeout(() => r('none'), 600)),
  ]);
  assert.equal(got, 'none');
});

// NOT TESTED HERE, and the reason is worth recording: the chargen EVICTION path
// (worldstate.authorityEnter -> authority.chargen_evict) cannot be reached from this harness.
// inChargen is set by the character-slot resolution in connection.ts, and a harness-registered
// account never goes through it, so a TestClient always looks like a finished character no
// matter what it does. Reproducing it needs a fixture that mints an incomplete character slot.
// Until then the eviction is covered only by the live server's own logs.

// THE FRESH-INSTALL BLOCKER (s170, backlog 451). A wizard-provisioned server closes
// registration -- the owner creates the accounts -- and the sim peer has no account until it
// makes one. Its SessionRegister was refused as "registration is disabled", its fallback
// login found no account, and the world simulated NOTHING for anybody: no NPCs, no combat,
// every client held on the loading screen. The peer is infrastructure and has already proved
// the shared server password by the time this gate runs.
test('the sim peer can register on a server with registration closed', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: {
      server: { password: PASS },
      login: { allowRegistration: false, allowHarnessAuth: true },
    },
  });
  t.after(() => server.close());

  const peer = await TestClient.simPeer(server.port, PASS); // throws if the register is refused
  t.after(() => peer.close());

  // The world simulates: that is the whole point of the peer getting in. (SessionReady is
  // processed a tick after simPeer() resolves.)
  for (let i = 0; i < 50 && !server.roster.inWorld().some((p) => p.system === true); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(server.roster.inWorld().some((p) => p.system === true), true, 'the peer is in the world');

  // ...and registration is still CLOSED for everyone else: a player is refused,
  const human = await TestClient.connect(server.port);
  t.after(() => human.close());
  human.hello();
  await human.waitJson('SessionHelloOk');
  human.sendJson({ t: 'SessionRegister', account: 'stranger', password: 'hunter22' });
  assert.equal((await human.waitJson('SessionDisconnect'))['code'], 'AUTH_FAILED');

  // ...and so is a stranger who merely DECLARES system=true without the shared password.
  const faker = await TestClient.connect(server.port);
  t.after(() => faker.close());
  faker.system = true;
  faker.hello();
  await faker.waitJson('SessionHelloOk');
  faker.sendJson({ t: 'SessionRegister', account: 'not-a-peer', password: 'x', serverPassword: 'wrong' });
  assert.equal((await faker.waitJson('SessionDisconnect'))['code'], 'AUTH_FAILED');
});
