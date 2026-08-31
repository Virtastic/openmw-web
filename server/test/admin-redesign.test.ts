// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The dashboard redesign's new surface: the sign-in landing page at /, one-step account
// creation, the wizard's persisted answers, inline SSO credentials, and the domain check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../src/server';
import { tmpDataDir } from './helpers';
import { readDashboardTree } from '../src/net/admin/settings-store';
import { validAccountName, accountNameProblem } from '../src/core/accounts';
import { normaliseDomain } from '../src/net/admin/setup-check';

const OWNER = { name: 'owner@example.com', password: 'a-long-enough-passphrase' };

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

test('the front door: / sends you to setup until it is done, then serves the sign-in page', async (t) => {
  const { base, call, token } = await boot(t);

  // Owner created (boot does that) but the wizard unfinished: there is no sign-in method
  // chosen and no world to enter, so the landing page would be a door into a server that
  // does not exist yet. Everyone goes to the one thing that matters.
  for (const path of ['/', '/play']) {
    const r = await fetch(`${base}${path}`, { redirect: 'manual' });
    assert.equal(r.status, 302, `${path} should redirect while setup is unfinished`);
    assert.equal(r.headers.get('location'), '/admin');
  }

  assert.equal((await call('/setup', { method: 'POST', token, body: {
    deploymentMode: 'multiplayer', loginMethods: ['password'], completed: true,
  } })).status, 200);

  // Finished: the real landing page, and no 404 for a player following a join link.
  for (const path of ['/', '/play']) {
    const r = await fetch(`${base}${path}`);
    assert.equal(r.status, 200, `${path} should serve the landing page`);
    const body = await r.text();
    // Anchored on what makes it the sign-in page, not on a sentence: this used to match a
    // subtitle, so deleting a line of copy failed a test about routing.
    assert.match(body, /id="options"/, 'it is the sign-in page');
    assert.match(body, /src="\/admin\/static\/play\.js"/, 'and it loads the sign-in script');
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

test('the owner signs in with an email, and a refused name says what is wrong with it', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const setup = (name: string, password = 'a-long-enough-passphrase') =>
    fetch(`http://127.0.0.1:${server.port}/admin/api/setup/owner`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, password }),
    });

  // A plain name is no longer enough for the OWNER: the wizard asks for an email so that
  // password recovery works without a shell on the box.
  const plain = await setup('admin');
  assert.equal(plain.status, 400);
  assert.match((await plain.json() as { error: string }).error, /email/i);

  // And the refusal names the actual problem rather than reciting the rule. The old message
  // ("2-24 characters: letters, numbers...") is what someone typing an email reads right
  // past, which is exactly how this was reported.
  const noDomain = await setup('me@localhost');
  assert.match((await noDomain.json() as { error: string }).error, /domain after the @/);
  const doubleDot = await setup('me..you@example.com');
  assert.match((await doubleDot.json() as { error: string }).error, /two dots in a row/);

  // The real thing works, and the address is kept as contact data so a reset can be sent.
  const ok = await setup('Owner.Person+mp@example.co.uk');
  assert.equal(ok.status, 200, 'plus-addressing and a multi-label domain are ordinary email');
  const token = (await ok.json() as { token: string }).token;
  const list = await (await fetch(`http://127.0.0.1:${server.port}/admin/api/accounts`, {
    headers: { authorization: `Bearer ${token}` },
  })).json() as { accounts: { name: string }[] };
  assert.equal(list.accounts[0]?.name, 'Owner.Person+mp@example.co.uk');
});

test('account names: emails allowed, 32-char plain names allowed, paths still impossible', () => {
  // Longer than the old 24-character cap, which was the other half of the report.
  assert.equal(validAccountName('a'.repeat(32)), true);
  assert.equal(validAccountName('a'.repeat(33)), false);
  assert.match(accountNameProblem('a'.repeat(33)) ?? '', /33 characters, and the limit is 32/);

  // Ordinary email shapes.
  for (const good of ['a@b.co', 'first.last@example.com', 'x+tag@sub.domain.org']) {
    assert.equal(validAccountName(good), true, `${good} should be a valid login`);
  }

  // The account name is lowercased into a storage key and concatenated into blob paths
  // (locker.ts: `gamedata/${key}/...`), so nothing that could climb out may pass.
  for (const bad of ['../../etc/passwd', 'a/b@example.com', 'a\b@example.com',
                     '..@example.com', 'x@example..com', 'a b@example.com', 'two@@example.com']) {
    assert.equal(validAccountName(bad), false, `${bad} must be refused`);
  }

  // And the message points at the offending character rather than reciting the rule.
  assert.match(accountNameProblem('bob!') ?? '', /cannot contain "!"/);
});

test('a Data Files folder can be uploaded without tripping the request budget', async (t) => {
  // THE BUG THIS PINS. Uploads are one request per file and the shared per-request budget is
  // 600/minute, ten a second, which is exactly the rate a local upload runs at. So the one
  // operation onboarding depends on sat on the limit and failed part-way through, and the
  // page reported it as "everything failed" with no cause. 700 files is past the burst, so
  // this fails outright if the exemption is ever removed.
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const owner = await fetch(`${base}/admin/api/setup/owner`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER),
  });
  const token = (await owner.json() as { token: string }).token;

  let ok = 0;
  let throttled = 0;
  for (let i = 0; i < 700; i++) {
    const r = await fetch(`${base}/admin/api/mods/upload?name=${encodeURIComponent(`Sound/Fx/clip${i}.wav`)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: Buffer.from('RIFF'),
    });
    if (r.status === 429) throttled++;
    else if (r.ok) ok++;
  }
  assert.equal(throttled, 0, 'not one file may be refused for arriving too fast');
  assert.equal(ok, 700, 'every file lands');

  // The budget still guards everything else: that is the point of exempting one route
  // rather than raising the limit for all of them.
  let apiThrottled = false;
  for (let i = 0; i < 800 && !apiThrottled; i++) {
    apiThrottled = (await fetch(`${base}/admin/api/overview`, {
      headers: { authorization: `Bearer ${token}` },
    })).status === 429;
  }
  assert.equal(apiThrottled, true, 'ordinary API calls are still budgeted');
});

test('the wizard configures HTTPS itself instead of naming a file to edit', async (t) => {
  // The hosting step used to end with "here is the line, go put it in a .env we cannot
  // reach". For an audience assumed never to have opened a shell, that is not a setup step,
  // it is where setup stops. The proxy config is rendered into the shared data directory
  // instead, and Caddy runs with --watch, so writing it IS applying it.
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const owner = await fetch(`${base}/admin/api/setup/owner`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER),
  });
  const token = (await owner.json() as { token: string }).token;
  const caddyfile = join(dataDir, 'caddy', 'Caddyfile');

  // Written at boot, before anyone has answered anything, so a restored backup or a deleted
  // file comes back with a working proxy rather than needing the wizard re-run.
  const atBoot = readFileSync(caddyfile, 'utf8');
  assert.match(atBoot, /^localhost \{/m, 'no domain yet: localhost only');
  assert.match(atBoot, /tls internal/, 'and a certificate it signs itself');

  // Answering the hosting question applies it.
  assert.equal((await fetch(`${base}/admin/api/setup`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ hosting: 'public', domain: 'mp.example.com', completed: true }),
  })).status, 200);
  const withDomain = readFileSync(caddyfile, 'utf8');
  assert.match(withDomain, /^mp\.example\.com \{/m, 'the domain gets its own site block');
  assert.doesNotMatch(withDomain.split('localhost {')[0]!, /tls internal/,
    'and NO tls directive, which is how Caddy is told to fetch a public certificate');
  // localhost survives alongside it: a mistyped domain must never take the dashboard away,
  // because the operator's own machine is how they would fix it.
  assert.match(withDomain, /^localhost \{/m);

  // Going internal-only clears the domain rather than leaving a stale name being served.
  assert.equal((await fetch(`${base}/admin/api/setup`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ hosting: 'internal', completed: true }),
  })).status, 200);
  assert.doesNotMatch(readFileSync(caddyfile, 'utf8'), /mp\.example\.com/);
});

test('registration is its own answer, and single player no longer closes it behind your back', async (t) => {
  const { call, token, dataDir } = await boot(t);

  // The bug: picking "single player" used to force allowRegistration=false, a decision the
  // operator never made and could not see, on a server their friends may well be joining.
  assert.equal((await call('/setup', { method: 'POST', token, body: {
    deploymentMode: 'single', registration: 'open', completed: true,
  } })).status, 200);
  let written = readDashboardTree(dataDir) as { login?: Record<string, unknown> };
  assert.equal(written.login?.allowRegistration, true,
    'single player with open sign-ups stays open');

  // Invite mode carries the code, and clears it again when sign-ups are opened up.
  assert.equal((await call('/setup', { method: 'POST', token, body: {
    deploymentMode: 'single', registration: 'invite', inviteCode: 'friends-only', completed: true,
  } })).status, 200);
  written = readDashboardTree(dataDir) as { login?: Record<string, unknown> };
  assert.equal(written.login?.allowRegistration, true);
  assert.equal(written.login?.inviteCode, 'friends-only');

  // And closed really is closed, in either mode.
  assert.equal((await call('/setup', { method: 'POST', token, body: {
    deploymentMode: 'multiplayer', registration: 'closed', completed: true,
  } })).status, 200);
  written = readDashboardTree(dataDir) as { login?: Record<string, unknown> };
  assert.equal(written.login?.allowRegistration, false, 'multiplayer can be closed too');
  assert.equal(written.login?.inviteCode, '', 'and the stale code does not linger');
});

test('S3 credentials are asked for in the browser, stored, and masked on read', async (t) => {
  // They used to be environment-only, so "use S3" was a setting the dashboard could ask
  // about and never finish: it collected an endpoint and a bucket, then told the operator to
  // go and set two variables in a file it cannot reach.
  const { call, token, dataDir } = await boot(t);
  assert.equal((await call('/setup', { method: 'POST', token, body: {
    storage: 's3',
    s3: { endpoint: 'https://x.r2.cloudflarestorage.com', bucket: 'worlds', region: 'auto',
          accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'the-actual-secret' },
    completed: true,
  } })).status, 200);

  const written = readDashboardTree(dataDir) as { locker?: Record<string, unknown> };
  assert.equal(written.locker?.accessKeyId, 'AKIAEXAMPLE');
  assert.equal(written.locker?.secretAccessKey, 'the-actual-secret');

  // BOTH are secrets on the way back out. secretAccessKey matched the pattern already;
  // accessKeyId did not, so it would have been readable in plaintext by a `viewer` — the
  // role the UI describes as "can look, and nothing else".
  const settings = await (await call('/settings', { token })).json() as {
    sections: { name: string; fields: { key: string; value: unknown; secret?: boolean }[] }[];
  };
  const locker = settings.sections.find((s) => s.name === 'locker');
  for (const key of ['accessKeyId', 'secretAccessKey']) {
    const f = locker?.fields.find((x) => x.key === key);
    assert.equal(f?.secret, true, `${key} must be treated as a secret`);
    assert.notEqual(f?.value, 'AKIAEXAMPLE');
    assert.notEqual(f?.value, 'the-actual-secret');
  }
});

test('re-running Setup does not blank what it does not re-ask', async (t) => {
  // THE FLOW BUG. The wizard sends every answer on every save, and re-entering it started
  // from blank, so a second run through Setup wrote domain="" over a working domain: the
  // proxy config was regenerated without it and the certificate stopped being used. The
  // page seeds itself from /state to avoid that, so /state has to actually carry the values.
  const { call, token, dataDir } = await boot(t);
  assert.equal((await call('/setup', { method: 'POST', token, body: {
    deploymentMode: 'multiplayer', hosting: 'public', domain: 'mp.example.com',
    registration: 'invite', inviteCode: 'come-in', storage: 's3',
    s3: { endpoint: 'https://x.r2.cloudflarestorage.com', bucket: 'worlds', region: 'auto',
          accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'the-actual-secret' },
    completed: true,
  } })).status, 200);

  const state = await (await call('/state', { token })).json() as {
    setup: Record<string, unknown>;
  };
  // Everything the wizard needs to pre-fill rather than re-ask.
  assert.equal(state.setup.domain, 'mp.example.com', 'the domain must come back');
  assert.equal(state.setup.registration, 'invite');
  assert.equal(state.setup.s3Endpoint, 'https://x.r2.cloudflarestorage.com');
  assert.equal(state.setup.s3Bucket, 'worlds');
  // The keys themselves must NOT: they are secrets. A boolean is enough for the storage
  // step to stop demanding two values the operator cannot see.
  assert.equal(state.setup.storageConfigured, true);
  assert.equal(JSON.stringify(state.setup).includes('the-actual-secret'), false,
    '/state must never carry the secret itself');

  // And the proxy config still names the domain, which is what the blanking broke.
  assert.match(readFileSync(join(dataDir, 'caddy', 'Caddyfile'), 'utf8'), /^mp\.example\.com \{/m);
});

test('a domain pasted out of the address bar is understood, not refused', async (t) => {
  // What people type is not "mp.example.com", it is what they copied from the address bar.
  // The check button refused that as "not a domain name" while Continue saved it verbatim,
  // so the value that reached the proxy config was one the wizard had already called invalid
  // and the join link came out as https://https://mp.example.com/.
  const { call, token, dataDir } = await boot(t);

  assert.equal(normaliseDomain('https://MP.Example.com:443/admin'), 'mp.example.com');
  assert.equal(normaliseDomain('  http://mp.example.com/  '), 'mp.example.com');
  assert.equal(normaliseDomain('mp.example.com.'), 'mp.example.com');
  // www is a genuinely different host: rewriting it would fetch a certificate for a name
  // the operator did not ask for.
  assert.equal(normaliseDomain('www.example.com'), 'www.example.com');

  // The check endpoint accepts it rather than lecturing about format.
  assert.equal((await call('/setup/check-domain', {
    method: 'POST', token, body: { domain: 'https://not-a-real-host-9x8y.example/' },
  })).status, 200, 'a pasted URL is a domain the check can act on');

  // And the saved value is the bare host, so the proxy config is well formed.
  assert.equal((await call('/setup', { method: 'POST', token, body: {
    hosting: 'public', domain: 'https://mp.example.com/', completed: true,
  } })).status, 200);
  assert.equal((readDashboardTree(dataDir) as { setup?: Record<string, unknown> })
    .setup?.domain, 'mp.example.com');
  const caddyfile = readFileSync(join(dataDir, 'caddy', 'Caddyfile'), 'utf8');
  assert.match(caddyfile, /^mp\.example\.com \{/m);
  assert.doesNotMatch(caddyfile, /https:\/\/mp/, 'no scheme in the site address');
});

test('a sign-in provider with no keys is reported, not silently ignored', async (t) => {
  // Ticking Discord without filling in its keys leaves it enabled in config and never
  // offered on the sign-in page, because there is nothing to sign in with. The operator
  // picked a button they would then be unable to find, and nothing said why.
  const { call, token } = await boot(t);
  assert.equal((await call('/setup', { method: 'POST', token, body: {
    loginMethods: ['password', 'discord'], completed: true,
  } })).status, 200);

  let state = await (await call('/state', { token })).json() as { setup: Record<string, unknown> };
  assert.deepEqual(state.setup.ssoNeedsKeys, ['discord'],
    'enabled but unusable, so the page can say so and the checklist can nag');
  assert.deepEqual(state.setup.ssoConfigured, []);

  // Supplying the keys clears it, so the nag ends by itself rather than needing dismissal.
  assert.equal((await call('/setup', { method: 'POST', token, body: {
    loginMethods: ['password', 'discord'],
    ssoCreds: { discord: { clientId: 'id', clientSecret: 'secret' } },
    completed: true,
  } })).status, 200);
  state = await (await call('/state', { token })).json() as { setup: Record<string, unknown> };
  assert.deepEqual(state.setup.ssoNeedsKeys, []);
  assert.deepEqual(state.setup.ssoConfigured, ['discord']);
});

test('the reachability nonce is served, and is the only thing at that path', async (t) => {
  // "Public" must not be a claim the operator can make unchecked. DNS resolving proves the
  // name points SOMEWHERE, and something answering on 443 proves a machine is there; neither
  // proves it is this one. A value this process invented coming back does.
  const { base } = await boot(t);
  const r = await fetch(`${base}/.well-known/openmw-web-verify`);
  assert.equal(r.status, 200, 'unauthenticated on purpose: the probe arrives from outside');
  const nonce = (await r.text()).trim();
  assert.match(nonce, /^[0-9a-f]{32}$/, 'a random value, not a guessable constant');
  // Stable within the process, so a probe issued now matches the answer given later.
  assert.equal((await (await fetch(`${base}/.well-known/openmw-web-verify`)).text()).trim(), nonce);
});

test('a single-player server is healthy without game data or a sim peer', async (t) => {
  // The two modes are different products sharing a server. Multiplayer owns the world and
  // runs a headless OpenMW to move every NPC, so no game data means no world. Single player
  // is the launcher's cloud locker: the engine runs in the player's own browser against
  // their own files, and this server holds accounts, that library and their saves.
  //
  // deploymentMode reached nothing outside the dashboard UI, so choosing single player still
  // produced a server in setup mode, refusing the one player it was set up for and reporting
  // itself unhealthy for a job nobody asked it to do.
  const dataDir = tmpDataDir();
  const first = await startServer({ dataDir, port: 0, host: '127.0.0.1' });
  const call = (p: string, o: RequestInit = {}) => fetch(`http://127.0.0.1:${first.port}/admin/api${p}`, o);
  const owner = await call('/setup/owner', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER),
  });
  const token = (await owner.json() as { token: string }).token;
  await call('/setup', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ deploymentMode: 'single', completed: true }),
  });
  await first.close();

  // Restart, so the stored answer is loaded the way a real restart loads it.
  const single = await startServer({ dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => single.close());
  assert.equal((await fetch(`http://127.0.0.1:${single.port}/healthz`)).status, 200,
    'no game data, no peer, and still healthy: there is no world to simulate');
});

test('a multiplayer server still refuses to pretend it has a world', async (t) => {
  // The guard that matters is unchanged. A server that owns a world and cannot simulate it
  // must not look like a working one.
  const dataDir = tmpDataDir();
  const first = await startServer({ dataDir, port: 0, host: '127.0.0.1' });
  const call = (p: string, o: RequestInit = {}) => fetch(`http://127.0.0.1:${first.port}/admin/api${p}`, o);
  const owner = await call('/setup/owner', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER),
  });
  const token = (await owner.json() as { token: string }).token;
  await call('/setup', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ deploymentMode: 'multiplayer', completed: true }),
  });
  await first.close();

  const mp = await startServer({ dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => mp.close());
  assert.equal((await fetch(`http://127.0.0.1:${mp.port}/healthz`)).status, 503,
    'multiplayer with no game data is a broken server and must say so');
});

test('password sign-in mints a game ticket, and refuses everything it should', async (t) => {
  // Tickets could previously only come from the SSO callback, or be reissued to someone who
  // already held a locker session, which itself only came from SSO. So a server with
  // allowPasswordLogin on offered players a method no client could complete: the wizard
  // listed it, the account existed, and there was no route from a password to a ticket.
  const dataDir = tmpDataDir();
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: { auth: { allowPasswordLogin: true }, limits: { loginPerMinPerIp: 600 } },
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const post = (body: unknown) => fetch(`${base}/auth/password`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  await server.accounts.register('Player', 'a-real-players-passphrase');

  const ok = await post({ name: 'Player', password: 'a-real-players-passphrase' });
  assert.equal(ok.status, 200);
  const body = await ok.json() as { ticket: string; account: string; name: string };
  assert.ok(body.ticket && body.ticket.length > 16, 'a ticket comes back');
  assert.equal(body.account, 'player');
  assert.equal(body.name, 'Player');

  // Wrong password and unknown account answer identically: anything else is a way to learn
  // which names exist.
  const bad = await post({ name: 'Player', password: 'not-the-password' });
  const nobody = await post({ name: 'NoSuchPerson', password: 'not-the-password' });
  assert.equal(bad.status, 401);
  assert.equal(nobody.status, 401);
  assert.deepEqual(await bad.json(), await nobody.json());
});

test('password sign-in is refused when the operator turned it off', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    // A provider has to be enabled alongside: loadConfig refuses password-off with no SSO,
    // because that combination is a server nobody can sign in to at all.
    configOverride: {
      auth: {
        allowPasswordLogin: false,
        google: { enabled: true, clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://x/cb' },
      },
    },
  });
  t.after(() => server.close());
  await server.accounts.register('Player', 'a-real-players-passphrase');
  const r = await fetch(`http://127.0.0.1:${server.port}/auth/password`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Player', password: 'a-real-players-passphrase' }),
  });
  assert.equal(r.status, 403, 'the setting is the gate, not just a hidden button');
});
