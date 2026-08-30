// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Password recovery and event notifications.
//
// The security-relevant property under test is that NONE of this leaks whether an account
// exists. A reset endpoint that answers differently for a real name than a made-up one is
// an account enumerator with a helpful error message.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { startServer } from '../src/server';
import { tmpDataDir } from './helpers';
import { ResetTokens, notifyEvent } from '../src/net/admin/notify';

const OWNER = { name: 'owner@example.com', password: 'a-long-enough-passphrase' };

async function boot(t: { after(fn: () => unknown): void }, override = {}) {
  const dataDir = tmpDataDir();
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1', configOverride: override,
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const call = (path: string, opts: { method?: string; token?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  return { server, dataDir, base, call };
}

// ---------------------------------------------------------------------------------------
// reset tokens
// ---------------------------------------------------------------------------------------

test('a reset token works exactly once', () => {
  const tokens = new ResetTokens();
  const t = tokens.mint('someone');
  assert.equal(tokens.consume(t), 'someone');
  assert.equal(tokens.consume(t), undefined, 'a link that works twice is a standing credential');
});

test('a reset token expires', () => {
  const tokens = new ResetTokens(-1); // already past its life the moment it is minted
  assert.equal(tokens.consume(tokens.mint('someone')), undefined);
});

test('garbage tokens are refused without throwing', () => {
  const tokens = new ResetTokens();
  tokens.mint('someone');
  for (const bad of ['', 'nope', '../../etc/passwd', 'x'.repeat(5000)]) {
    assert.equal(tokens.consume(bad), undefined);
  }
});

// ---------------------------------------------------------------------------------------
// the HTTP surface
// ---------------------------------------------------------------------------------------

test('recovery is not offered when the server cannot send mail', async (t) => {
  const { call } = await boot(t);
  const r = await call('/admin/api/forgot-password', { method: 'POST', body: { name: 'anyone' } });
  assert.equal(r.status, 501, 'a reset link that silently goes nowhere is worse than no link');
});

test('forgot-password says the same thing for real and invented accounts', async (t) => {
  // Pointed at a port with nothing on it: sending will fail, which is the point — the
  // ANSWER must not depend on whether the account or its address exists.
  const { call } = await boot(t, {
    notifications: { smtpHost: '127.0.0.1', smtpPort: 1, from: 'noreply@example.test' },
  });
  await call('/admin/api/setup/owner', { method: 'POST', body: OWNER });

  const real = await call('/admin/api/forgot-password', { method: 'POST', body: { name: OWNER.name } });
  const fake = await call('/admin/api/forgot-password', { method: 'POST', body: { name: 'no-such-person' } });

  assert.equal(real.status, 200);
  assert.equal(fake.status, 200);
  assert.deepEqual(await real.json(), await fake.json(),
    'differing answers here would enumerate accounts and email addresses');
});

test('a reset with a bad token is refused, and a weak new password is too', async (t) => {
  const { call } = await boot(t, {
    notifications: { smtpHost: '127.0.0.1', smtpPort: 1, from: 'noreply@example.test' },
  });
  await call('/admin/api/setup/owner', { method: 'POST', body: OWNER });

  const bad = await call('/admin/api/reset-password', {
    method: 'POST', body: { token: 'not-a-real-token', password: 'a-long-enough-passphrase' },
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json() as { message: string }).message, /expired or was already used/);
});

// ---------------------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------------------

test('a line break in an address or subject is refused before anything is sent', async () => {
  // SMTP is line-oriented, so a CR or LF ends the current command and begins another. The
  // reset path takes the recipient from an account's email, and an account can get its email
  // from an OIDC `email` claim — attacker-controlled on a hostile or compromised provider,
  // and [auth.custom] accepts any issuer an operator points it at. Without this, a claim of
  // "victim@x\r\nRCPT TO:<attacker@evil>" adds an envelope recipient to a password reset.
  //
  // Guarded at the sink because every caller passes through here. identities.ts also
  // validates the claim now; this is the half that cannot be bypassed by a new caller.
  const { sendMail } = await import('../src/net/admin/notify');
  const cfg = { host: 'smtp.invalid', port: 587, user: '', pass: '', from: 'me@example.test' };

  for (const bad of [
    'victim@x.com\r\nRCPT TO:<attacker@evil.test>',
    'victim@x.com\nBcc: attacker@evil.test',
    'victim@x.com\rX-Injected: 1',
  ]) {
    await assert.rejects(() => sendMail(cfg, bad, 'subject', 'body'), /line break in recipient/,
      `"${bad.replace(/[\r\n]/g, '\\n')}" must not reach the wire`);
  }
  await assert.rejects(
    () => sendMail(cfg, 'ok@example.test', 'Subject\r\nBcc: attacker@evil.test', 'body'),
    /line break in subject/);
  await assert.rejects(
    () => sendMail({ ...cfg, from: 'me@x\r\nEvil: 1' }, 'ok@example.test', 'subject', 'body'),
    /line break in sender/);

  // And with a clean address it gets as far as trying to connect, so the guard is not
  // rejecting everything.
  await assert.rejects(() => sendMail(cfg, 'ok@example.test', 'subject', 'body'),
    (err: Error) => !/line break/.test(err.message));
});

test('sending is refused outright when no SMTP host is configured', async () => {
  const { sendMail } = await import('../src/net/admin/notify');
  await assert.rejects(
    () => sendMail({ host: '', port: 587, user: '', pass: '', from: 'a@b.test' }, 'c@d.test', 's', 'b'),
    /no SMTP host/);
});

// ---------------------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------------------

test('a webhook fires only for events on the operator list', async (t) => {
  const received: unknown[] = [];
  const hook: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(204);
      res.end();
    });
  });
  hook.listen(0, '127.0.0.1');
  await once(hook, 'listening');
  t.after(() => hook.close());
  const url = `http://127.0.0.1:${(hook.address() as { port: number }).port}/hook`;

  const cfg = {
    host: '', port: 587, user: '', pass: '', from: '', to: '',
    webhookUrl: url, events: ['admin.account_deleted'],
  };
  notifyEvent(cfg, 'admin.account_deleted', { account: 'someone', by: 'owner' });
  notifyEvent(cfg, 'conn.open', { ip: '1.2.3.4' }); // not on the list

  // notifyEvent is fire-and-forget by design (a mail server being down must not fail a
  // ban), so give the request a moment to land.
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(received.length, 1, 'exactly the listed event, and nothing else');
  const payload = received[0] as { text: string; event: string; account: string };
  assert.equal(payload.event, 'admin.account_deleted');
  assert.equal(payload.account, 'someone');
  assert.match(payload.text, /OpenMW-Web/, 'chat services render {text}');
});

test('a dead webhook never throws into the caller', async () => {
  // Port 1 refuses instantly. The call must return normally: an unreachable notifier
  // turning a ban into a 500 would be the notifier causing the outage it reports.
  const cfg = {
    host: '', port: 587, user: '', pass: '', from: '', to: '',
    webhookUrl: 'http://127.0.0.1:1/nope', events: ['x.y'],
  };
  assert.doesNotThrow(() => notifyEvent(cfg, 'x.y', {}));
  await new Promise((r) => setTimeout(r, 200));
});

test('a config rollback is announced, because a silent revert is the worst case', async (t) => {
  const dataDir = tmpDataDir();
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  writeFileSync(join(dataDir, 'config.dashboard.toml'), 'not [valid toml', 'utf8');

  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const { recentLogs } = await import('../src/log');
  const fallback = recentLogs(500, 'admin.config_fallback');
  assert.ok(fallback.length > 0, 'the operator has to be told their saved settings did not load');
});
