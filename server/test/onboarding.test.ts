// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Onboarding: ProfileSetup validation (email/username formats, blocklist, uniqueness,
// rename cooldown), the requireProfile Ready gate, username-as-display-name, the
// email-never-on-the-wire invariant.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

function profile(c: TestClient, email: string, username: string, optIn = false): void {
  c.sendJson({ t: 'ProfileSetup', email, username, ...(optIn ? { marketingOptIn: true } : {}) });
}

test('ProfileSetup: validates, stores, and makes the username the display name', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const c = await TestClient.connect(server.port);
  const { welcome } = await c.joinAsNew('Alice');
  assert.equal((welcome['profile'] as { required: boolean }).required, false); // default off

  profile(c, 'not-an-email', 'GoodName');
  let r = await c.waitJson('ProfileResult');
  assert.deepEqual([r['ok'], r['error']], [false, 'badformat-email']);

  profile(c, 'alice@example.com', 'no spaces!');
  r = await c.waitJson('ProfileResult');
  assert.deepEqual([r['ok'], r['error']], [false, 'badformat-username']);

  profile(c, 'alice@example.com', 'Moderator');
  r = await c.waitJson('ProfileResult');
  assert.deepEqual([r['ok'], r['error']], [false, 'reserved-word']);

  profile(c, 'alice@example.com', 'AliceTheBrave', true);
  r = await c.waitJson('ProfileResult');
  assert.equal(r['ok'], true);
  c.close();

  // Display name on the next login is the handle, not the account name; Welcome echoes
  // the owner's own profile back.
  const c2 = await TestClient.connect(server.port);
  const w2 = await c2.joinExisting('Alice');
  const prof = w2['profile'] as { username?: string; email?: string };
  assert.equal(prof.username, 'AliceTheBrave');
  assert.equal(prof.email, 'alice@example.com');

  // OT3-47: a second ProfileSetup cannot repoint the address on file.
  profile(c2, 'mallory@example.com', 'AliceTheBrave');
  await c2.waitJson('ProfileResult');
  const acc = await server.accounts.get('alice');
  assert.equal(acc?.email, 'alice@example.com');
  assert.equal(acc?.emailVerified, undefined); // typed, so never verified

  // The email must appear in NO peer-visible payload: a second player's entire inbox
  // (json + events) after both are in-world must not contain it.
  const c3 = await TestClient.connect(server.port);
  await c3.joinAsNew('Bob');
  await c3.waitEvent('PlayerList');
  const everything = JSON.stringify(c3.inbox);
  assert.ok(!everything.includes('alice@example.com'), 'email leaked to a peer');
  assert.ok(everything.includes('AliceTheBrave') || !everything.includes('Alice'),
    'peers see the handle, not the account name');
  c2.close();
  c3.close();
});

test('username uniqueness is case-insensitive and cross-account', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Alice');
  profile(a, 'alice@example.com', 'Nerevar');
  assert.equal((await a.waitJson('ProfileResult'))['ok'], true);

  const b = await TestClient.connect(server.port);
  await b.joinAsNew('Bob');
  profile(b, 'bob@example.com', 'NEREVAR');
  const r = await b.waitJson('ProfileResult');
  assert.deepEqual([r['ok'], r['error']], [false, 'taken']);

  // Rename immediately after setting: cooldown refuses.
  profile(a, 'alice@example.com', 'Indoril');
  const r2 = await a.waitJson('ProfileResult');
  assert.deepEqual([r2['ok'], r2['error']], [false, 'cooldown']);
  a.close();
  b.close();
});

test('requireProfile gates Ready until the profile is complete', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false,
    dataDir, port: 0, host: '127.0.0.1',
    configOverride: { login: { requireProfile: true } },
  });
  t.after(() => server.close());

  const c = await TestClient.connect(server.port);
  c.hello();
  await c.waitJson('SessionHelloOk');
  c.register('Alice', 'hunter22');
  const w = await c.waitJson('SessionWelcome');
  assert.equal((w['profile'] as { required: boolean }).required, true);

  // Ready before the profile: refused (session stays alive), not entered into the world.
  c.sendJson({ t: 'SessionReady' });
  const refused = await c.waitJson('ProfileResult');
  assert.deepEqual([refused['ok'], refused['error']], [false, 'profile-required']);

  profile(c, 'alice@example.com', 'AliceTheBrave');
  assert.equal((await c.waitJson('ProfileResult'))['ok'], true);
  c.sendJson({ t: 'SessionReady' });
  await c.waitEvent('PlayerList'); // now in-world
  c.close();
});

