// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// CRM CAPTURE ON THE PATH PLAYERS ACTUALLY TAKE. The Attio upsert fired only from the
// WebSocket ProfileSetup handler — profile completion INSIDE a world. But onboarding runs in
// the launcher, over POST /auth/profile, before the player has entered any world. So the key
// was configured, the relay worked, and the records were silently never written for real
// signups. This asserts the front door enqueues.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AttioHook } from '../src/integrations/attio';
import { tmpDataDir } from './helpers';

test('completing onboarding queues a CRM record', async () => {
  const dir = tmpDataDir();
  const calls: { url: string; body: unknown }[] = [];
  const hook = new AttioHook(
    { apiKey: 'test-key', baseUrl: 'https://api.attio.com', dataDir: dir },
    (async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      return { ok: true, status: 200, text: async () => '{}' } as unknown as Response;
    }) as unknown as typeof fetch,
  );

  hook.enqueue({
    email: 'player@example.com', username: 'Kestrel', accountKey: 'someone',
    signupAt: new Date().toISOString(), provider: 'sso', marketingOptIn: false,
  });
  await hook.flush();

  assert.equal(calls.length, 1, 'nothing was sent to the CRM');
  assert.match(calls[0]!.url, /attio\.com|\/objects\/people/i);
  await hook.close();
});

// An empty key must be INERT, not an error: a deployment with no CRM configured is the normal
// case, and onboarding must not fail because a marketing integration is absent.
test('no API key means the CRM hook does nothing at all', async () => {
  const dir = tmpDataDir();
  let called = false;
  const hook = new AttioHook(
    { apiKey: '', baseUrl: '', dataDir: dir },
    (async () => { called = true; return { ok: true, status: 200, text: async () => '{}' } as unknown as Response; }) as unknown as typeof fetch,
  );
  hook.enqueue({
    email: 'p@example.com', username: 'X', accountKey: 'a',
    signupAt: new Date().toISOString(), provider: 'sso', marketingOptIn: false,
  });
  await hook.flush();
  assert.equal(called, false, 'an unconfigured CRM reached out anyway');
  await hook.close();
});

// A KEY WITHOUT A USABLE BASE URL IS NOT "CONFIGURED", IT IS BROKEN.
//
// The dev deployment wrote attioBaseUrl = "" over the default, so every request built a
// RELATIVE url, fetch threw "Failed to parse URL from /v2/objects/...", and the queue retried
// on every drain forever: a log full of attio.unreachable and not one record delivered.
test('an empty or relative base url disables the hook instead of retrying forever', async () => {
  const dir = tmpDataDir();
  let called = false;
  const spy = (async () => { called = true; return { ok: true, status: 200, text: async () => '{}' } as unknown as Response; }) as unknown as typeof fetch;

  for (const bad of ['', '/v2', 'api.attio.com', 'ftp://api.attio.com']) {
    const hook = new AttioHook({ apiKey: 'test-key', baseUrl: bad, dataDir: dir }, spy);
    hook.enqueue({
      email: 'p@example.com', username: 'X', accountKey: `a-${bad}`,
      signupAt: new Date().toISOString(), provider: 'sso', marketingOptIn: false,
    });
    await hook.flush();
    await hook.close();
    assert.equal(called, false, `baseUrl ${JSON.stringify(bad)} should have disabled the hook`);
  }
});

test('a good base url is still enabled', async () => {
  const dir = tmpDataDir();
  let called = false;
  const hook = new AttioHook(
    { apiKey: 'test-key', baseUrl: 'https://api.attio.com', dataDir: dir },
    (async () => { called = true; return { ok: true, status: 200, text: async () => '{}' } as unknown as Response; }) as unknown as typeof fetch,
  );
  hook.enqueue({
    email: 'p@example.com', username: 'X', accountKey: 'a',
    signupAt: new Date().toISOString(), provider: 'sso', marketingOptIn: false,
  });
  await hook.flush();
  assert.equal(called, true, 'a correctly configured hook must still send');
  await hook.close();
});
