// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
//
// POST /auth/password/register: a new player makes their own account on a password server.
//
// Before it, /auth/password only signed EXISTING accounts in, so a server whose only sign-in
// method was a password had no way in for a new player: the wizard's "invite only" answer gave
// the owner an invite link that opened a sign-in form nobody new could pass. These pin the
// gates (its own switch, off by default; registration open; password sign-in on; the invite
// code; the name and password rules; bans) and that success is an ordinary password sign-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../src/server';
import { tmpDataDir } from './helpers';
import { resetInviteBudgets } from '../src/auth/invite';
import { BanStore } from '../src/persist/banstore';

const PASS = 'a-real-players-passphrase';

async function boot(
  t: { after(fn: () => unknown): void }, login: Record<string, unknown>,
  auth: Record<string, unknown> = {}, dataDir = tmpDataDir(),
) {
  resetInviteBudgets();
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: {
      auth: { allowPasswordLogin: true, ...auth },
      // Every test below runs with the switch on, unless it passes its own value.
      login: { allowPasswordSignup: true, ...login },
      limits: { loginPerMinPerIp: 600 },
    },
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const register = (body: unknown) => post('/auth/password/register', body);
  const providers = async () => await (await fetch(`${base}/auth/providers`)).json() as
    { allowPasswordSignup?: boolean; inviteRequired?: boolean };
  return { server, post, register, providers };
}

test('off by default: an open server offers no sign-up form and refuses the route', async (t) => {
  // No allowPasswordSignup in the override at all: config.default.toml decides.
  resetInviteBudgets();
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { auth: { allowPasswordLogin: true }, login: { allowRegistration: true, inviteCode: '' } },
  });
  t.after(() => server.close());
  assert.equal(server.config.login.allowPasswordSignup, false);
  const base = `http://127.0.0.1:${server.port}`;
  const p = await (await fetch(`${base}/auth/providers`)).json() as { allowPasswordSignup?: boolean };
  assert.equal(p.allowPasswordSignup, false, 'the page must not offer it');
  const r = await fetch(`${base}/auth/password/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Nerevar', password: PASS }),
  });
  assert.equal(r.status, 403);
  assert.equal(await server.accounts.get('Nerevar'), undefined, 'no account was created');
});

test('an invite-only password server lets a new player in with the code, and only with it', async (t) => {
  const { post, register, providers } = await boot(t, { allowRegistration: true, inviteCode: 'Seyda Neen 427' });

  const p = await providers();
  assert.equal(p.allowPasswordSignup, true, 'the page must be told it can offer sign-up');
  assert.equal(p.inviteRequired, true);

  const none = await register({ name: 'Nerevar', password: PASS });
  assert.equal(none.status, 403);
  assert.equal((await none.json() as { code: string }).code, 'invite_required');

  const wrong = await register({ name: 'Nerevar', password: PASS, invite: 'balmora' });
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json() as { code: string }).code, 'invite_required');

  // Typed the way a phone types it: capitalised, spaces gone. auth/invite.ts folds both.
  const ok = await register({ name: 'Nerevar', password: PASS, invite: 'seydaneen427' });
  assert.equal(ok.status, 200, await ok.clone().text());
  const body = await ok.json() as { ticket: string; account: string; name: string; created: boolean };
  assert.ok(body.ticket && body.ticket.length > 16, 'a ticket comes back, as on sign-in');
  assert.equal(body.account, 'nerevar');
  assert.equal(body.name, 'Nerevar');
  assert.equal(body.created, true);

  // The account is real: the ordinary sign-in now works, with no code.
  const signin = await post('/auth/password', { name: 'Nerevar', password: PASS });
  assert.equal(signin.status, 200);

  // A second sign-up for the same name (any case) is refused and changes nothing.
  const again = await register({ name: 'NEREVAR', password: 'another-long-passphrase', invite: 'Seyda Neen 427' });
  assert.equal(again.status, 409);
  assert.equal((await post('/auth/password', { name: 'Nerevar', password: PASS })).status, 200,
    'the first owner keeps their password');
});

test('name and password problems are answered without spending an invite guess', async (t) => {
  const { register } = await boot(t, { allowRegistration: true, inviteCode: 'right-code' });
  // Six weak attempts: past the five guesses one address gets (auth/invite.ts).
  for (let i = 0; i < 6; i++) {
    const r = await register({ name: 'Caius', password: 'short', invite: 'right-code' });
    assert.equal(r.status, 400);
    assert.match((await r.json() as { error: string }).error, /12 characters/);
  }
  const bad = await register({ name: 'no@pe', password: PASS, invite: 'right-code' });
  assert.equal(bad.status, 400);
  const own = await register({ name: 'Caius', password: 'caius-is-my-password', invite: 'right-code' });
  assert.equal(own.status, 400, 'a password holding the name is refused');
  const common = await register({ name: 'Caius', password: 'Administrator', invite: 'right-code' });
  assert.equal(common.status, 400);
  assert.equal((await common.json() as { error: string }).error,
    'password is one of the most common passwords in the world');
  const ok = await register({ name: 'Caius', password: PASS, invite: 'right-code' });
  assert.equal(ok.status, 200, 'the code still works after the typing mistakes');
});

test('wrong codes run out: the invite budget applies here too', async (t) => {
  const { register } = await boot(t, { allowRegistration: true, inviteCode: 'right-code' });
  for (let i = 0; i < 5; i++) {
    assert.equal((await register({ name: `Guess${i}`, password: PASS, invite: `guess-${i}` })).status, 403);
  }
  const locked = await register({ name: 'Guess9', password: PASS, invite: 'right-code' });
  assert.equal(locked.status, 403, 'a right code made while locked out is refused like any other');
  assert.equal((await locked.json() as { code: string }).code, 'invite_locked');
});

test('an open server needs no code', async (t) => {
  const { register, providers } = await boot(t, { allowRegistration: true, inviteCode: '' });
  const p = await providers();
  assert.equal(p.allowPasswordSignup, true);
  assert.equal(p.inviteRequired, false);
  assert.equal((await register({ name: 'Jiub', password: PASS })).status, 200);
});

test('closed registration and password sign-in off both refuse, and say so to the page', async (t) => {
  const switchedOff = await boot(t, { allowRegistration: true, inviteCode: '', allowPasswordSignup: false });
  assert.equal((await switchedOff.providers()).allowPasswordSignup, false);
  assert.equal((await switchedOff.register({ name: 'Fargoth', password: PASS })).status, 403);

  const closed = await boot(t, { allowRegistration: false, inviteCode: '' });
  assert.equal((await closed.providers()).allowPasswordSignup, false);
  assert.equal((await closed.register({ name: 'Fargoth', password: PASS })).status, 403);

  const ssoOnly = await boot(t, { allowRegistration: true, inviteCode: '' }, {
    allowPasswordLogin: false,
    google: { enabled: true, clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://x/cb' },
  });
  assert.equal((await ssoOnly.providers()).allowPasswordSignup, false);
  assert.equal((await ssoOnly.register({ name: 'Fargoth', password: PASS })).status, 403,
    'the setting is the gate, not just a hidden link');
});

test('a banned name cannot be signed up again', async (t) => {
  // Banned before the server starts, the way a ban made earlier sits in the data dir.
  const dataDir = tmpDataDir();
  const seed = new BanStore(dataDir);
  seed.banAccount('Fargoth', 'test', 'thief');
  await seed.close();
  const { server, register } = await boot(t, { allowRegistration: true, inviteCode: '' }, {}, dataDir);
  const r = await register({ name: 'Fargoth', password: PASS });
  assert.equal(r.status, 403);
  assert.equal(await server.accounts.get('Fargoth'), undefined, 'no account was created');
});

test('the front door offers sign-up and posts it to the register route', () => {
  const play = readFileSync(join(process.cwd(), 'web', 'play.js'), 'utf8');
  assert.ok(play.includes("'/auth/password/register'"), 'the form must be able to create an account');
  assert.ok(play.includes('auth.allowPasswordSignup'), 'only where the server allows it');
  assert.ok(play.includes('Create an account'), 'a new player must see the way in');
  assert.ok(/invite: \(\$\('#pwInvite'\)\?\.value \|\| invited \|\| ''\)\.trim\(\)/.test(play),
    'the code from the invite link (or typed) rides on the sign-up');
  assert.ok(play.includes("invited && !returning) setSignup(true)"),
    'an invite link opens on "create an account" for a browser that never signed in');
});
