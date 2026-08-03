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

test('a player joining an unsimulated world is told it is not ready yet', async (t) => {
  const server = await boot(t);

  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  await a.joinAsNew('Solo', 'hunter22');

  const msg = await a.waitEvent('SimReady');
  // No peer has said hello, so the honest answer is false and the client holds its screen.
  assert.equal((msg.value as { ready?: boolean }).ready, false);
});

test('when the peer comes up, everyone already waiting is told', async (t) => {
  const server = await boot(t);

  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  await a.joinAsNew('Waiting', 'hunter22');
  assert.equal(((await a.waitEvent('SimReady')).value as { ready?: boolean }).ready, false);

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
