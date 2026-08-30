// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The dashboard redesign's new surface: the sign-in landing page at /, one-step account
// creation, the wizard's persisted answers, inline SSO credentials, and the domain check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { tmpDataDir } from './helpers';
import { readDashboardTree } from '../src/net/admin/settings-store';

const OWNER = { name: 'TheOwner', password: 'a-long-enough-passphrase' };

async function boot(t: { after(fn: () => unknown): void }, override = {}) {
  const dataDir = tmpDataDir();
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: override,
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const call = (path: string, opts: { method?: string; token?: string; body?: unknown } = {}) =>
    fetch(`${base}/admin/api${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  const owner = await call('/setup/owner', { method: 'POST', body: OWNER });
  assert.equal(owner.status, 200);
  const token = (await owner.json() as { token: string }).token;
  return { base, call, token, dataDir };
}

test('the front door: / serves the sign-in landing page, not a 404', async (t) => {
  const { base } = await boot(t);
  for (const path of ['/', '/play']) {
    const r = await fetch(`${base}${path}`);
    assert.equal(r.status, 200, `${path} should serve the landing page`);
    const body = await r.text();
    assert.match(body, /Sign in to play/, 'it is the sign-in page');
    assert.doesNotMatch(body, /<script>/, 'no inline script: the page runs under script-src self');
  }
});

test('accounts/create makes a working dashboard login in one step, owner only', async (t) => {
  const { call, token } = await boot(t);

  // Role gate: a moderator cannot mint accounts.
  const modMake = await call('/accounts/create', {
    method: 'POST', token, body: { name: 'Mod', password: 'steady-hillside-copper', role: 'moderator' },
  });
  assert.equal(modMake.status, 200);
  const modLogin = await call('/login', { method: 'POST', body: { name: 'Mod', password: 'steady-hillside-copper' } });
  assert.equal(modLogin.status, 200, 'the created account can sign straight in');
  const mod = await modLogin.json() as { token: string; role: string };
  assert.equal(mod.role, 'moderator');
  assert.equal((await call('/accounts/create', {
    method: 'POST', token: mod.token, body: { name: 'Sneaky', password: 'whatever-long-enough', role: 'owner' },
  })).status, 403, 'a moderator cannot create accounts');

  // Guard rails: junk role, weak password, and a taken name are all refused with a reason.
  assert.equal((await call('/accounts/create', {
    method: 'POST', token, body: { name: 'X1', password: 'long-enough-password', role: 'god' },
  })).status, 400);
  assert.equal((await call('/accounts/create', {
    method: 'POST', token, body: { name: 'X2', password: 'short', role: 'viewer' },
  })).status, 400);
  const dup = await call('/accounts/create', {
    method: 'POST', token, body: { name: 'Mod', password: 'another-long-passphrase', role: 'viewer' },
  });
  assert.equal(dup.status, 400);
  assert.match((await dup.json() as { error: string }).error, /taken/);
});

test('wizard answers persist whole, and /state carries the setup record', async (t) => {
  const { call, token, dataDir } = await boot(t);
  const applied = await call('/setup', { method: 'POST', token, body: {
    deploymentMode: 'single', contentProfile: 'expansions', deliveryModel: 'verify',
    hosting: 'internal', storage: 'local', loginMethods: ['password'], completed: true,
  } });
  assert.equal(applied.status, 200);

  // The pivot answers, ALL of them, written to the override file the next boot loads: this
  // is what lets the UI hide multiplayer pages on a single-player deployment, and what
  // re-entering Setup pre-fills from. An earlier build kept only two of these and threw the
  // rest away, which is why "single player" still showed every multiplayer menu.
  const written = readDashboardTree(dataDir) as { setup?: Record<string, unknown> };
  assert.equal(written.setup?.deploymentMode, 'single');
  assert.equal(written.setup?.contentProfile, 'expansions');
  assert.equal(written.setup?.deliveryModel, 'verify');
  assert.equal(written.setup?.hosting, 'internal');
  assert.equal(written.setup?.storage, 'local');
  assert.deepEqual(written.setup?.loginMethods, ['password']);
  assert.equal(written.setup?.completed, true);

  // /state exposes the LOADED setup record (it changes at restart, like every setting);
  // what matters here is the shape: the field exists for the page to branch on.
  const state = await (await call('/state', { token })).json() as { setup: Record<string, unknown> };
  assert.ok(state.setup && typeof state.setup === 'object');
  assert.ok('deploymentMode' in state.setup, 'the config default supplies every key');

  // The [setup] bookkeeping is not a settings form: re-running Setup edits it, not a card
  // full of raw strings nobody should hand-edit.
  const settings = await (await call('/settings', { token })).json() as { sections: { name: string }[] };
  assert.equal(settings.sections.some((s) => s.name === 'setup'), false);
});

test('wizard SSO credentials land in config, and read back masked', async (t) => {
  const { call, token, dataDir } = await boot(t);
  const applied = await call('/setup', { method: 'POST', token, body: {
    deploymentMode: 'multiplayer', loginMethods: ['password', 'discord'],
    ssoCreds: { discord: { clientId: 'client-123', clientSecret: 'super-secret-value',
      redirectUri: 'https://mp.example.com/auth/discord/callback' } },
  } });
  assert.equal(applied.status, 200);

  // The settings API shows the LOADED config, which only changes at restart, so the write is
  // checked at its destination: the dashboard's own override file.
  const written = readDashboardTree(dataDir) as {
    auth?: { discord?: Record<string, unknown> };
  };
  assert.equal(written.auth?.discord?.enabled, true);
  assert.equal(written.auth?.discord?.clientId, 'client-123');
  assert.equal(written.auth?.discord?.clientSecret, 'super-secret-value');
  assert.equal(written.auth?.discord?.redirectUri, 'https://mp.example.com/auth/discord/callback');

  // And what does go back over the wire is masked: clientSecret matches the secret pattern.
  const settings = await (await call('/settings', { token })).json() as {
    sections: { name: string; fields: { key: string; value: unknown; secret?: boolean }[] }[];
  };
  const discord = settings.sections.find((s) => s.name === 'auth.discord');
  assert.ok(discord, 'the provider table renders as its own section');
  const secretField = discord!.fields.find((f) => f.key === 'clientSecret');
  assert.equal(secretField?.secret, true);
  assert.notEqual(secretField?.value, 'super-secret-value');
});

test('check-domain validates input and is owner-gated; no live DNS in tests', async (t) => {
  const { call, token } = await boot(t);
  assert.equal((await call('/setup/check-domain', {
    method: 'POST', token, body: { domain: 'not a domain!!' },
  })).status, 400, 'garbage is refused before any lookup happens');
  assert.equal((await call('/setup/check-domain', {
    method: 'POST', body: { domain: 'example.com' },
  })).status, 401, 'no credential, no probe: this endpoint makes outbound requests');
});

test('maintenance mode survives the restart it exists to precede', async (t) => {
  // Its stated use case is "turn it on, change things, restart" and every settings change
  // ends in a restart, so in-memory state switched itself off at exactly the wrong moment
  // and readmitted players into the half-edited server.
  const dataDir = tmpDataDir();
  const first = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  const call1 = (path: string, opts: RequestInit = {}) => fetch(`http://127.0.0.1:${first.port}/admin/api${path}`, opts);
  const owner = await call1('/setup/owner', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(OWNER),
  });
  const token = (await owner.json() as { token: string }).token;
  await call1('/maintenance', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ on: true, message: 'back in ten' }),
  });
  await first.close();

  // The "restart": a second process over the same data dir.
  const second = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => second.close());
  const state = await (await fetch(`http://127.0.0.1:${second.port}/admin/api/state`)).json() as {
    maintenance: { on: boolean; message: string };
  };
  assert.equal(state.maintenance.on, true, 'still in maintenance after the restart');
  assert.equal(state.maintenance.message, 'back in ten');
});
