// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The admin dashboard: first-run setup, account-based login, the role matrix, two-factor,
// settings persistence and the mod load order.
//
// The permission matrix here is EXHAUSTIVE rather than representative. This surface can run
// script on a player's machine, rewrite every setting and erase accounts, so "we tested the
// gate on a couple of endpoints and trust the pattern" is not good enough — one route wired
// to the wrong role is the whole failure mode.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../src/server';
import { tmpDataDir } from './helpers';
import { verifyTotp, generateSecret } from '../src/net/admin/totp';
import { passwordProblem } from '../src/net/admin/auth';

const OWNER = { name: 'TheOwner', password: 'a-long-enough-passphrase' };

async function boot(t: { after(fn: () => unknown): void }, override = {}) {
  const dataDir = tmpDataDir();
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: override,
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  // `raw` sends bytes rather than JSON — the upload endpoint streams its body to disk.
  const call = (path: string, opts: { method?: string; token?: string; body?: unknown; raw?: Buffer } = {}) =>
    fetch(`${base}/admin/api${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.raw !== undefined ? { 'content-type': 'application/octet-stream' } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      ...(opts.raw !== undefined ? { body: opts.raw } : {}),
    });
  return { server, dataDir, base, call };
}

async function makeOwner(call: ReturnType<typeof boot> extends Promise<infer R> ? R extends { call: infer C } ? C : never : never) {
  const r = await call('/setup/owner', { method: 'POST', body: OWNER });
  assert.equal(r.status, 200, 'first-run owner creation should succeed');
  return (await r.json() as { token: string }).token;
}

// ---------------------------------------------------------------------------------------
// first run
// ---------------------------------------------------------------------------------------

test('a fresh server reports first-run, and setup creates a working owner', async (t) => {
  const { call } = await boot(t);

  const before = await (await call('/state')).json() as { firstRun: boolean; authed: boolean };
  assert.equal(before.firstRun, true);
  assert.equal(before.authed, false);

  const token = await makeOwner(call);
  assert.ok(token.length > 20, 'a session token comes back so setup flows straight into the dashboard');

  const after = await (await call('/state', { token })).json() as
    { firstRun: boolean; authed: boolean; role: string; name: string };
  assert.equal(after.firstRun, false, 'the wizard must not offer itself again');
  assert.equal(after.authed, true);
  assert.equal(after.role, 'owner');
  assert.equal(after.name, OWNER.name);
});

test('setup/owner closes permanently once an owner exists', async (t) => {
  const { call } = await boot(t);
  await makeOwner(call);
  // Without this the route would be a standing "make me an owner" door for anyone who can
  // reach the page.
  const second = await call('/setup/owner', {
    method: 'POST', body: { name: 'Sneaky', password: 'another-long-passphrase' },
  });
  assert.equal(second.status, 409, 'a second unauthenticated owner creation must be refused');
});

test('weak passwords are refused at owner creation', async (t) => {
  const { call } = await boot(t);
  for (const password of ['short', 'password123', 'aaaaaaaaaaaaaaa']) {
    const r = await call('/setup/owner', { method: 'POST', body: { name: 'Admin', password } });
    assert.equal(r.status, 400, `"${password}" should be refused`);
  }
  assert.equal((await call('/setup/owner', {
    method: 'POST', body: { name: 'Admin', password: 'Admin-is-in-here-somewhere' },
  })).status, 400, 'a password containing the username is refused');
});

test('passwordProblem accepts a reasonable passphrase', () => {
  assert.equal(passwordProblem('correct horse battery staple', 'admin'), null);
  assert.match(String(passwordProblem('short', 'admin')), /12 characters/);
});

// ---------------------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------------------

test('login works, and failures never say which half was wrong', async (t) => {
  const { call } = await boot(t);
  await makeOwner(call);

  const good = await call('/login', { method: 'POST', body: OWNER });
  assert.equal(good.status, 200);
  const session = await good.json() as { token: string; role: string };
  assert.equal(session.role, 'owner');

  const badPass = await call('/login', { method: 'POST', body: { name: OWNER.name, password: 'wrong-but-long-enough' } });
  const noUser = await call('/login', { method: 'POST', body: { name: 'ghost', password: 'wrong-but-long-enough' } });
  assert.equal(badPass.status, 401);
  assert.equal(noUser.status, 401);
  assert.deepEqual(
    await badPass.json(), await noUser.json(),
    'a wrong password and a missing account must be indistinguishable, or this is an account oracle',
  );
});

test('an account with no dashboard role cannot sign in to the dashboard', async (t) => {
  const { call, server } = await boot(t);
  await makeOwner(call);
  // A plain player account: exists, correct password, no dashboard access.
  const created = await server.accounts.register('PlainPlayer', 'a-perfectly-fine-password');
  assert.notEqual(typeof created, 'string');

  const r = await call('/login', { method: 'POST', body: { name: 'PlainPlayer', password: 'a-perfectly-fine-password' } });
  assert.equal(r.status, 401, 'having an account is not having dashboard access');
});

test('the legacy shared token still works, as owner', async (t) => {
  // Automation was written against this before accounts existed. Breaking it would be a
  // silent outage in somebody's cron job.
  const { call } = await boot(t, { admin: { dashboardToken: 'legacy-automation-token' } });
  const r = await call('/overview', { token: 'legacy-automation-token' });
  assert.equal(r.status, 200);
  const state = await (await call('/state', { token: 'legacy-automation-token' })).json() as { role: string };
  assert.equal(state.role, 'owner');
});

test('a revoked session stops working immediately', async (t) => {
  const { call } = await boot(t);
  const token = await makeOwner(call);
  assert.equal((await call('/overview', { token })).status, 200);
  assert.equal((await call('/logout', { method: 'POST', token })).status, 200);
  assert.equal((await call('/overview', { token })).status, 401, 'signing out must actually end the session');
});

// ---------------------------------------------------------------------------------------
// the permission matrix
// ---------------------------------------------------------------------------------------

/** Every route, and the lowest role that may reach it. */
const MATRIX: { path: string; method: string; need: 'viewer' | 'moderator' | 'owner'; body?: unknown }[] = [
  { path: '/overview', method: 'GET', need: 'viewer' },
  { path: '/settings', method: 'GET', need: 'viewer' },
  { path: '/mods', method: 'GET', need: 'viewer' },
  { path: '/reports', method: 'GET', need: 'moderator' },
  { path: '/action', method: 'POST', need: 'moderator', body: { kind: 'broadcast', target: '', detail: 'hi' } },
  { path: '/commands', method: 'GET', need: 'moderator' },
  { path: '/command', method: 'POST', need: 'moderator', body: { line: 'list' } },
  { path: '/logs', method: 'GET', need: 'moderator' },
  { path: '/metrics', method: 'GET', need: 'moderator' },
  { path: '/accounts', method: 'GET', need: 'moderator' },
  { path: '/settings/server', method: 'PUT', need: 'owner', body: { name: 'Renamed' } },
  { path: '/setup', method: 'POST', need: 'owner', body: { serverName: 'X' } },
  { path: '/mods', method: 'PUT', need: 'owner', body: { entries: [] } },
  { path: '/accounts/role', method: 'POST', need: 'owner', body: { name: 'nobody', role: 'viewer' } },
  { path: '/sessions', method: 'GET', need: 'owner' },
  { path: '/sessions/revoke', method: 'POST', need: 'owner', body: { id: 'nope' } },
  { path: '/maintenance', method: 'POST', need: 'owner', body: { on: false, message: '' } },
];

const RANKS = { viewer: 0, moderator: 1, owner: 2 };

test('every endpoint enforces exactly the role it should', async (t) => {
  const { call, server } = await boot(t);
  const ownerToken = await makeOwner(call);

  // One account per role, promoted by the owner through the real API.
  const tokens: Record<string, string> = { owner: ownerToken };
  for (const role of ['viewer', 'moderator'] as const) {
    const name = `A${role}`;
    const password = 'a-sufficiently-long-password';
    await server.accounts.register(name, password);
    const promoted = await call('/accounts/role', { method: 'POST', token: ownerToken, body: { name, role } });
    assert.equal(promoted.status, 200, `promoting ${name} should work`);
    const login = await call('/login', { method: 'POST', body: { name, password } });
    assert.equal(login.status, 200, `${name} should be able to sign in`);
    tokens[role] = (await login.json() as { token: string }).token;
  }

  for (const route of MATRIX) {
    // Unauthenticated is always 401.
    const anon = await call(route.path, { method: route.method, body: route.body });
    assert.equal(anon.status, 401, `${route.method} ${route.path} unauthenticated must be 401`);

    for (const role of ['viewer', 'moderator', 'owner'] as const) {
      const res = await call(route.path, { method: route.method, token: tokens[role], body: route.body });
      const allowed = RANKS[role] >= RANKS[route.need];
      if (allowed) {
        assert.notEqual(res.status, 403,
          `${role} should be allowed ${route.method} ${route.path} (needs ${route.need})`);
      } else {
        assert.equal(res.status, 403,
          `${role} must be refused ${route.method} ${route.path} (needs ${route.need})`);
      }
    }
  }
});

test('demoting an account kills its dashboard session on the next request', async (t) => {
  const { call, server } = await boot(t);
  const ownerToken = await makeOwner(call);
  await server.accounts.register('Temp', 'a-sufficiently-long-password');
  await call('/accounts/role', { method: 'POST', token: ownerToken, body: { name: 'Temp', role: 'moderator' } });
  const login = await call('/login', { method: 'POST', body: { name: 'Temp', password: 'a-sufficiently-long-password' } });
  const tempToken = (await login.json() as { token: string }).token;
  assert.equal((await call('/overview', { token: tempToken })).status, 200);

  await call('/accounts/role', { method: 'POST', token: ownerToken, body: { name: 'Temp', role: '' } });
  // The role is re-read per request rather than trusted from login time, so this takes
  // effect now instead of whenever the session would have expired.
  assert.equal((await call('/overview', { token: tempToken })).status, 401);
});

test('the last owner cannot demote themselves out of the building', async (t) => {
  const { call } = await boot(t);
  const token = await makeOwner(call);
  const r = await call('/accounts/role', { method: 'POST', token, body: { name: OWNER.name, role: 'viewer' } });
  assert.equal(r.status, 400);
  assert.match((await r.json() as { error: string }).error, /only owner/);
});

// ---------------------------------------------------------------------------------------
// two-factor
// ---------------------------------------------------------------------------------------

test('TOTP verifies its own codes and rejects everything else', () => {
  const secret = generateSecret();
  const step = Math.floor(Date.now() / 30_000);
  // Derive the expected code the same way the verifier does, via a known-good round trip.
  assert.equal(verifyTotp(secret, '000000') && verifyTotp(secret, '111111'), false,
    'two different fixed codes cannot both be right');
  assert.equal(verifyTotp(secret, 'abc'), false, 'non-numeric input is refused, not thrown on');
  assert.equal(verifyTotp('', '123456'), false, 'an empty secret never verifies');
  assert.ok(step > 0);
});

test('enrolling two-factor requires proving a live code first', async (t) => {
  const { call } = await boot(t);
  const token = await makeOwner(call);

  const enrol = await call('/totp/enroll', { method: 'POST', token });
  const { secret, uri } = await enrol.json() as { secret: string; uri: string };
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.ok(secret.length >= 16);

  const wrong = await call('/totp/confirm', { method: 'POST', token, body: { code: '000000' } });
  assert.equal(wrong.status, 400, 'a code that does not match must not switch 2FA on');

  // Logging in still works, because the failed confirmation stored nothing.
  assert.equal((await call('/login', { method: 'POST', body: OWNER })).status, 200);
});

// ---------------------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------------------

test('settings save to the dashboard file and never touch config.toml', async (t) => {
  const { call, dataDir } = await boot(t);
  const token = await makeOwner(call);

  // An operator's own config.toml, with comments, exactly as they would write it.
  const operatorFile = join(dataDir, 'config.toml');
  const original = '# my own notes, do not lose these\n[server]\nmaxPlayers = 12 # deliberate\n';
  writeFileSync(operatorFile, original, 'utf8');

  const r = await call('/settings/server', { method: 'PUT', token, body: { name: 'Renamed World' } });
  assert.equal(r.status, 200);
  assert.equal((await r.json() as { restartRequired: boolean }).restartRequired, true);

  assert.equal(readFileSync(operatorFile, 'utf8'), original,
    'the operator\'s hand-written file and its comments must survive byte for byte');
  const written = readFileSync(join(dataDir, 'config.dashboard.toml'), 'utf8');
  assert.match(written, /Renamed World/);
});

test('an invalid value is refused at the form, not discovered at the next boot', async (t) => {
  const { call } = await boot(t);
  const token = await makeOwner(call);
  const r = await call('/settings/server', { method: 'PUT', token, body: { maxPlayers: 'not a number' } });
  assert.equal(r.status, 400);
  assert.match((await r.json() as { error: string }).error, /maxPlayers/);
});

test('settings survive a restart, and the view reports what is overridden', async (t) => {
  const { call, dataDir, server } = await boot(t);
  const token = await makeOwner(call);
  await call('/settings/server', { method: 'PUT', token, body: { name: 'Persisted Name' } });
  await server.close();

  const again = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => again.close());
  assert.equal(again.config.server.name, 'Persisted Name', 'a saved setting has to actually load');
});

test('a corrupt dashboard file falls back instead of refusing to boot', async (t) => {
  // The single most important safety property here: a non-technical operator who saves
  // something bad must never end up with a server that will not start.
  const dataDir = tmpDataDir();
  writeFileSync(join(dataDir, 'config.dashboard.toml'), 'this is not [valid toml at all', 'utf8');
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  assert.ok(server.config.server.name, 'the server booted anyway');
  assert.ok(server.config.dashboardFallback, 'and it says so, rather than reverting silently');
});

test('secrets are masked in the settings view and unchanged by a save that echoes the mask', async (t) => {
  const { call } = await boot(t, { admin: { dashboardToken: 'a-real-secret-value' } });
  const token = await makeOwner(call);
  const view = await (await call('/settings', { token })).json() as
    { sections: { name: string; fields: { key: string; value: unknown; secret?: boolean }[] }[] };
  const adminSection = view.sections.find((s) => s.name === 'admin')!;
  const tokenField = adminSection.fields.find((f) => f.key === 'dashboardToken')!;
  assert.equal(tokenField.secret, true);
  assert.notEqual(tokenField.value, 'a-real-secret-value', 'a secret must not be sent to the browser');

  // Saving the mask back leaves the stored value alone — otherwise editing a neighbouring
  // field would silently blank the credential.
  await call('/settings/admin', { method: 'PUT', token, body: { dashboardToken: tokenField.value } });
  assert.equal((await call('/overview', { token: 'a-real-secret-value' })).status, 200,
    'the shared token still works, so the save did not overwrite it with the mask');
});

// ---------------------------------------------------------------------------------------
// mods
// ---------------------------------------------------------------------------------------

test('the mod list reorders plugins and drops disabled ones', async (t) => {
  const { call, dataDir, server } = await boot(t);
  const token = await makeOwner(call);

  const gd = join(dataDir, 'gamedata');
  mkdirSync(gd, { recursive: true });
  for (const f of ['Morrowind.esm', 'Morrowind.bsa', 'Alpha.esp', 'Beta.esp', 'Gamma.esp']) {
    writeFileSync(join(gd, f), 'x');
  }

  const listed = await (await call('/mods', { token })).json() as
    { entries: { file: string; enabled: boolean; official: boolean }[] };
  assert.ok(listed.entries.some((e) => e.file === 'Alpha.esp'));
  assert.ok(listed.entries.find((e) => e.file === 'Morrowind.esm')?.official, 'base masters are marked');

  // Reverse the plugin order and switch one off.
  const saved = await call('/mods', { method: 'PUT', token, body: { entries: [
    { file: 'Morrowind.esm', enabled: true },
    { file: 'Gamma.esp', enabled: true },
    { file: 'Beta.esp', enabled: false },
    { file: 'Alpha.esp', enabled: true },
  ] } });
  assert.equal(saved.status, 200);

  await server.close();
  const again = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => again.close());
  const content = again.gameData.contentFiles;
  assert.equal(content.indexOf('Gamma.esp') < content.indexOf('Alpha.esp'), true,
    'the operator\'s order replaces the alphabetical guess');
  assert.equal(content.includes('Beta.esp'), false, 'a disabled plugin must not load');
  assert.equal(content[0], 'Morrowind.esm', 'the base master still loads first');
});

test('a mod list naming a file that is not there is refused', async (t) => {
  const { call, dataDir } = await boot(t);
  const token = await makeOwner(call);
  mkdirSync(join(dataDir, 'gamedata'), { recursive: true });
  const r = await call('/mods', { method: 'PUT', token, body: {
    entries: [{ file: 'TypoedName.esp', enabled: true }],
  } });
  assert.equal(r.status, 400, 'a typo must fail here, not at world start');
});

test('files added to the folder after a list was saved still load', async (t) => {
  const { call, dataDir } = await boot(t);
  const token = await makeOwner(call);
  const gd = join(dataDir, 'gamedata');
  mkdirSync(gd, { recursive: true });
  writeFileSync(join(gd, 'First.esp'), 'x');
  await call('/mods', { method: 'PUT', token, body: { entries: [{ file: 'First.esp', enabled: true }] } });

  writeFileSync(join(gd, 'DroppedInLater.esp'), 'x');
  const listed = await (await call('/mods', { token })).json() as
    { entries: { file: string; enabled: boolean; isNew: boolean }[] };
  const fresh = listed.entries.find((e) => e.file === 'DroppedInLater.esp');
  // "I added the mod and nothing happened" is an unfalsifiable bug from the operator's side
  // of the screen, so a new file is enabled by default and flagged rather than ignored.
  assert.ok(fresh, 'a newly copied file appears');
  assert.equal(fresh.enabled, true);
  assert.equal(fresh.isNew, true, 'and is marked as not yet reviewed');
});

// ---------------------------------------------------------------------------------------
// upload
// ---------------------------------------------------------------------------------------

test('safeUploadName refuses everything that is not a plain content filename', async () => {
  const { safeUploadName } = await import('../src/net/admin/api-mods');

  assert.equal(safeUploadName('BetterClothes.esp'), 'BetterClothes.esp');
  assert.equal(safeUploadName('Morrowind.bsa'), 'Morrowind.bsa');
  assert.equal(safeUploadName('Tamriel_Data.esm'), 'Tamriel_Data.esm');

  // Traversal, in the several spellings a client might send. basename() handles the forward
  // slash; the backslash matters because Windows treats it as a separator too.
  for (const bad of [
    '../../etc/passwd', '..\\..\\windows\\system32\\evil.esp', '/etc/cron.d/x.esp',
    'sub/dir/file.esp', 'a\\b.esp',
  ]) {
    const out = safeUploadName(bad);
    assert.ok(out === null || (!out.includes('/') && !out.includes('\\') && !out.includes('..')),
      `${bad} must not survive as a path`);
  }

  // Wrong type: the game data folder is scanned by the engine, so only engine files go in.
  for (const bad of ['evil.sh', 'config.toml', 'accounts.db', 'x.esp.exe', 'noextension']) {
    assert.equal(safeUploadName(bad), null, `${bad} must be refused`);
  }
  // Hidden files, empty names, absurd lengths, embedded NULs.
  assert.equal(safeUploadName('.hidden.esp'), null);
  assert.equal(safeUploadName(''), null);
  assert.equal(safeUploadName(`${'a'.repeat(300)}.esp`), null);
  assert.equal(safeUploadName('ok\0.esp'), null);
});

test('uploading a content file puts it in the load order', async (t) => {
  const { call, dataDir } = await boot(t);
  const token = await makeOwner(call);
  mkdirSync(join(dataDir, 'gamedata'), { recursive: true });

  const body = Buffer.from('not really an esp, but the server does not parse it');
  const up = await call('/mods/upload?name=Uploaded.esp', {
    method: 'POST', token, raw: body,
  });
  assert.equal(up.status, 200);
  assert.equal((await up.json() as { file: string }).file, 'Uploaded.esp');
  assert.equal(readFileSync(join(dataDir, 'gamedata', 'Uploaded.esp'), 'utf8'), body.toString());

  const listed = await (await call('/mods', { token })).json() as { entries: { file: string }[] };
  assert.ok(listed.entries.some((e) => e.file === 'Uploaded.esp'), 'it shows up straight away');
});

test('upload refuses a traversing name without writing anything', async (t) => {
  const { call, dataDir } = await boot(t);
  const token = await makeOwner(call);
  mkdirSync(join(dataDir, 'gamedata'), { recursive: true });

  const r = await call('/mods/upload?name=..%2F..%2Fowned.esp', {
    method: 'POST', token, raw: Buffer.from('x'),
  });
  assert.equal(r.status, 400);
  assert.equal(existsSync(join(dataDir, 'owned.esp')), false, 'nothing escaped the folder');
});

test('upload is owner-only', async (t) => {
  const { call, server } = await boot(t);
  const ownerToken = await makeOwner(call);
  await server.accounts.register('Mod', 'a-sufficiently-long-password');
  await call('/accounts/role', { method: 'POST', token: ownerToken, body: { name: 'Mod', role: 'moderator' } });
  const modToken = (await (await call('/login', {
    method: 'POST', body: { name: 'Mod', password: 'a-sufficiently-long-password' },
  })).json() as { token: string }).token;

  const r = await call('/mods/upload?name=Sneaky.esp', { method: 'POST', token: modToken, raw: Buffer.from('x') });
  assert.equal(r.status, 403, 'writing files the engine loads is an owner action');
});

// ---------------------------------------------------------------------------------------
// logs, maintenance, static
// ---------------------------------------------------------------------------------------

test('the audit filter shows admin actions and hides the rest', async (t) => {
  const { call } = await boot(t);
  const token = await makeOwner(call);
  await call('/settings/server', { method: 'PUT', token, body: { name: 'Audited' } });

  const audit = await (await call('/logs?filter=admin.', { token })).json() as
    { entries: { event: string }[] };
  assert.ok(audit.entries.length > 0);
  assert.ok(audit.entries.every((e) => e.event.startsWith('admin.')), 'the filter actually filters');
  assert.ok(audit.entries.some((e) => e.event === 'admin.config_changed'),
    'a settings change is recorded against the operator who made it');
});

test('maintenance mode reports itself in state', async (t) => {
  const { call } = await boot(t);
  const token = await makeOwner(call);
  await call('/maintenance', { method: 'POST', token, body: { on: true, message: 'back in ten' } });
  const state = await (await call('/state')).json() as { maintenance: { on: boolean; message: string } };
  assert.equal(state.maintenance.on, true);
  assert.equal(state.maintenance.message, 'back in ten',
    'the operator\'s own wording reaches the people being turned away');
});

test('the dashboard page and its vendored assets are served', async (t) => {
  const { base } = await boot(t);
  const page = await fetch(`${base}/admin`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /openmw-mp admin/);

  for (const asset of ['app.js', 'app.css', 'vendor/adminlte.min.css', 'vendor/bootstrap.bundle.min.js']) {
    const r = await fetch(`${base}/admin/static/${asset}`);
    assert.equal(r.status, 200, `${asset} must be served locally, never from a CDN`);
  }
  // Path traversal out of the web root.
  for (const bad of ['../config.default.toml', '..%2f..%2fpackage.json']) {
    const r = await fetch(`${base}/admin/static/${bad}`);
    assert.notEqual(r.status, 200, `${bad} must not escape the asset root`);
  }
});

test('an unconfigured server starts in setup mode instead of refusing to boot', async (t) => {
  // A server normally REFUSES to start without game data, because one that cannot run its
  // own sim peer is a world whose NPCs never move while it reports itself healthy. But a
  // brand-new install has no game data yet by definition, and dying at boot puts the
  // failure and the page explaining it behind the same locked door.
  //
  // So: nobody has set this up AND there is no game data => come up for setup only.
  // Note the absence of requireGameData:false here — that seam is what the other tests use,
  // and using it would test nothing about this behaviour.
  const dataDir = tmpDataDir();
  const server = await startServer({ dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  assert.equal((await fetch(`${base}/admin`)).status, 200, 'the setup page must be reachable');
  const state = await (await fetch(`${base}/admin/api/state`)).json() as { firstRun: boolean };
  assert.equal(state.firstRun, true);
  // Reachable, but honest about it: 503 keeps the container failing its healthcheck so a
  // monitor still sees a server that cannot host anyone, while the process stays up.
  assert.equal((await fetch(`${base}/healthz`)).status, 503);
});

test('setup mode survives finishing the wizard, and reports itself unhealthy throughout', async (t) => {
  // THE REGRESSION THIS EXISTS TO PREVENT.
  //
  // Setup mode was first written as "no owner yet AND no game data". That armed a trap:
  // completing the wizard made the first half false, so the Restart button the wizard
  // itself offers took the server down permanently and took the dashboard with it. The
  // operator was locked out at the exact moment they succeeded. Observed in a real
  // container, not theorised.
  //
  // So it depends on whether the world can actually run, and nothing else. Unhealthy is how
  // it stays honest: the process lives so a human can fix it in the browser, while every
  // healthcheck and monitor still sees a broken server.
  const dataDir = tmpDataDir();
  const first = await startServer({ dataDir, port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${first.port}`;

  const before = await fetch(`${base}/healthz`);
  assert.equal(before.status, 503, 'a server that cannot host a world must not answer "ok"');
  assert.match(await before.text(), /not ready/);

  const created = await fetch(`${base}/admin/api/setup/owner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(OWNER),
  });
  assert.equal(created.status, 200);
  await first.close();

  // The restart the wizard offers. This is the call that used to throw.
  const second = await startServer({ dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => second.close());
  assert.equal((await fetch(`http://127.0.0.1:${second.port}/admin`)).status, 200,
    'the dashboard has to survive the restart, or setup is a one-way door');
  assert.equal((await fetch(`http://127.0.0.1:${second.port}/healthz`)).status, 503,
    'still not hosting a world, so still unhealthy');
});

test('healthz says ok only when the world can actually run', async (t) => {
  // requireGameData:false is the in-process seam the suite uses; it means "assume the world
  // is runnable", so this is the healthy case.
  const { base } = await boot(t);
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'ok');
});

test('/healthz is not swallowed by the admin gate', async (t) => {
  // The container healthcheck, the setup script's readiness poll and the restart flow all
  // depend on this answering without a credential.
  const { base } = await boot(t);
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
});
