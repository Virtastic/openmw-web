// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Onboarding: ProfileSetup validation (email/username formats, blocklist, uniqueness,
// rename cooldown), the requireProfile Ready gate, username-as-display-name, the
// email-never-on-the-wire invariant, and the Attio queue (durability, drain, disabled).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../src/server';
import { AttioHook, type AttioUpsert } from '../src/integrations/attio';
import { TestClient, tmpDataDir } from './helpers';

function profile(c: TestClient, email: string, username: string, optIn = false): void {
  c.sendJson({ t: 'ProfileSetup', email, username, ...(optIn ? { marketingOptIn: true } : {}) });
}

test('ProfileSetup: validates, stores, and makes the username the display name', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ dataDir, port: 0, host: '127.0.0.1' });
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
  const server = await startServer({ dataDir, port: 0, host: '127.0.0.1' });
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
  const server = await startServer({
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

test('attio queue: durable, drains on success, survives outages, inert without a key', async () => {
  const dataDir = tmpDataDir();
  const queueDir = join(dataDir, 'integrations', 'attio-queue');
  const upsert: AttioUpsert = {
    email: 'x@example.com', username: 'X', accountKey: 'x',
    signupAt: new Date().toISOString(), provider: 'password', marketingOptIn: false,
  };

  // Disabled: nothing is queued, nothing is sent.
  let calls = 0;
  const off = new AttioHook({ apiKey: '', baseUrl: 'http://unused', dataDir }, (async () => {
    calls++;
    return new Response('{}', { status: 200 });
  }) as typeof fetch);
  off.enqueue(upsert);
  await off.close();
  assert.equal(calls, 0);
  assert.throws(() => readdirSync(queueDir)); // dir never even created

  // Outage: the item stays queued; recovery drains it.
  let fail = true;
  const hook = new AttioHook({ apiKey: 'k', baseUrl: 'http://api', dataDir }, (async () => {
    calls++;
    if (fail) throw new Error('ECONNREFUSED');
    return new Response('{}', { status: 200 });
  }) as typeof fetch);
  hook.enqueue(upsert);
  await new Promise((r) => setTimeout(r, 50)); // let the async enqueue+flush settle
  await hook.flush();
  assert.equal(readdirSync(queueDir).length, 1, 'failed upsert must stay queued');
  fail = false;
  await hook.flush();
  assert.equal(readdirSync(queueDir).length, 0, 'recovered flush must drain the queue');
  assert.ok(calls >= 2);

  // A queue entry from a previous run (crash durability) is picked up by a fresh hook.
  mkdirSync(queueDir, { recursive: true });
  writeFileSync(join(queueDir, '1-old.json'), JSON.stringify(upsert));
  const hook2 = new AttioHook({ apiKey: 'k', baseUrl: 'http://api', dataDir }, (async () =>
    new Response('{}', { status: 200 })) as typeof fetch);
  await hook2.flush();
  assert.equal(readdirSync(queueDir).length, 0, 'boot flush must drain leftovers');
  await hook.close();
  await hook2.close();

  // purgeAccount removes queued PII for delete-my-data.
  writeFileSync(join(queueDir, '2-x.json'), JSON.stringify(upsert));
  writeFileSync(join(queueDir, '3-y.json'), JSON.stringify({ ...upsert, accountKey: 'y' }));
  await hook2.purgeAccount('x');
  assert.deepEqual(readdirSync(queueDir), ['3-y.json']);
});

test('signup succeeds while attio is down (never blocks the hot path)', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({
    dataDir, port: 0, host: '127.0.0.1',
    // Key set but pointing at a dead endpoint: enqueue works, delivery fails, auth is fine.
    configOverride: { integrations: { attioApiKey: 'k', attioBaseUrl: 'http://127.0.0.1:1' } },
  });
  t.after(() => server.close());

  const c = await TestClient.connect(server.port);
  await c.joinAsNew('Alice');
  profile(c, 'alice@example.com', 'AliceTheBrave');
  assert.equal((await c.waitJson('ProfileResult'))['ok'], true);
  await new Promise((r) => setTimeout(r, 100));
  const queued = readdirSync(join(dataDir, 'integrations', 'attio-queue'));
  assert.equal(queued.length, 1, 'undeliverable upsert must be durably queued');
  c.close();
});
