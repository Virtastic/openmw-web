// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase B SSO, driven end to end against a MOCK OpenID provider that runs in-process with
// a freshly generated RSA key — so CI needs no live Discord/Google/Microsoft credentials
// and every rejection path (bad signature, wrong aud, wrong iss, expired, replayed state)
// can actually be produced rather than argued about.
//
// The browser is simulated with fetch + redirect:'manual': the test follows the same 302s
// and carries the same cookie a real browser would.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as signBuf, type KeyObject } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, type RunningServer } from '../src/server';
import type { DeepPartial, Config } from '../src/config';
import { LoginTicketStore } from '../src/auth/identities';
import { TestClient, tmpDataDir } from './helpers';

// ------------------------------------------------------------- mock provider

interface CodeSpec {
  sub: string;
  nameHint?: string;
  email?: string; // deliberately varied between logins: nothing may key on it
  aud?: string; // override -> wrong-audience token
  iss?: string; // override -> wrong-issuer token
  expDelta?: number; // seconds relative to now (negative -> expired)
  nonce?: string; // override -> nonce mismatch
  badSignature?: boolean;
  alg?: string;
}

interface PendingCode extends CodeSpec {
  challenge: string;
  nonce: string;
  redirectUri: string;
}

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
}

class MockIdp {
  readonly clientId = 'omw-mp-test-client';
  readonly clientSecret = 'test-client-secret';
  private readonly key: KeyObject;
  private readonly jwk: Record<string, unknown>;
  private readonly codes = new Map<string, PendingCode>();
  private http!: Server;
  issuer = '';
  lastAuthorize?: URL;
  tokenRequests = 0;

  constructor(readonly kid = 'test-key-1') {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.key = privateKey;
    this.jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, alg: 'RS256', use: 'sig' };
  }

  async start(port: number): Promise<void> {
    this.issuer = `http://127.0.0.1:${port}`;
    this.http = createServer((req, res) => {
      const url = new URL(req.url ?? '/', this.issuer);
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/.well-known/openid-configuration') {
        json(200, {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          jwks_uri: `${this.issuer}/jwks`,
        });
        return;
      }
      if (url.pathname === '/jwks') {
        json(200, { keys: [this.jwk] });
        return;
      }
      if (url.pathname === '/authorize') {
        // A real IdP would show a consent screen here; the test records the request and
        // mints codes explicitly via issueCode() so it can control every claim.
        this.lastAuthorize = url;
        json(200, { ok: true });
        return;
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        this.tokenRequests++;
        let raw = '';
        req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
        req.on('end', () => {
          const form = new URLSearchParams(raw);
          const pending = this.codes.get(form.get('code') ?? '');
          if (!pending) return json(400, { error: 'invalid_grant' });
          this.codes.delete(form.get('code') ?? ''); // codes are single use
          if (form.get('grant_type') !== 'authorization_code') return json(400, { error: 'unsupported_grant_type' });
          if (form.get('client_id') !== this.clientId || form.get('client_secret') !== this.clientSecret)
            return json(401, { error: 'invalid_client' });
          if (form.get('redirect_uri') !== pending.redirectUri) return json(400, { error: 'invalid_redirect' });
          // The PKCE check that makes a stolen code useless.
          const verifier = form.get('code_verifier') ?? '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (verifier === '' || challenge !== pending.challenge) return json(400, { error: 'invalid_grant_pkce' });
          return json(200, { access_token: 'mock-access-token', token_type: 'Bearer', id_token: this.idToken(pending) });
        });
        return;
      }
      json(404, { error: 'not_found' });
    });
    await new Promise<void>((resolve) => this.http.listen(port, '127.0.0.1', resolve));
  }

  private idToken(spec: PendingCode): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: spec.alg ?? 'RS256', typ: 'JWT', kid: this.kid };
    const payload = {
      iss: spec.iss ?? this.issuer,
      sub: spec.sub,
      aud: spec.aud ?? this.clientId,
      iat: now,
      exp: now + (spec.expDelta ?? 600),
      nonce: spec.nonce,
      ...(spec.nameHint ? { preferred_username: spec.nameHint } : {}),
      ...(spec.email ? { email: spec.email, email_verified: true } : {}),
    };
    const signing = `${b64url(header)}.${b64url(payload)}`;
    const sig = signBuf('sha256', Buffer.from(signing, 'utf8'), this.key);
    if (spec.badSignature) sig[0] = sig[0]! ^ 0xff; // one flipped bit is all it takes
    return `${signing}.${sig.toString('base64url')}`;
  }

  // Mints an authorization code for the challenge/nonce of a real /auth/*/start request.
  issueCode(authorize: URL, spec: CodeSpec): string {
    const code = randomBytes(12).toString('hex');
    this.codes.set(code, {
      ...spec,
      challenge: authorize.searchParams.get('code_challenge') ?? '',
      nonce: spec.nonce ?? authorize.searchParams.get('nonce') ?? '',
      redirectUri: authorize.searchParams.get('redirect_uri') ?? '',
    });
    return code;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

// ------------------------------------------------------------------- harness

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

const RETURN_URL = 'https://example.invalid/play/';

interface Harness {
  server: RunningServer;
  idp: MockIdp;
  idp2: MockIdp;
  dataDir: string;
  base: string;
}

// Two mock issuers: `custom` and `google` (its issuer is overridden to point at the second
// mock), which is what makes the linking tests possible without live credentials.
async function boot(
  t: { after(fn: () => unknown): void },
  override: DeepPartial<Config> = {},
  dataDir = tmpDataDir(),
): Promise<Harness> {
  // An SSO (multiplayer) server refuses to boot without game data (server.ts). These tests
  // exercise auth, not content, so stub the files detectGameData looks for — presence is all
  // it checks. This keeps the production invariant ("no server without files") intact.
  { const gd = nodePath.join(dataDir, 'gamedata'); mkdirSync(gd, { recursive: true });
    for (const f of ['Morrowind.esm', 'Morrowind.bsa']) writeFileSync(nodePath.join(gd, f), ''); }
  const idp = new MockIdp('key-a');
  const idp2 = new MockIdp('key-b');
  await idp.start(await freePort());
  await idp2.start(await freePort());
  const port = await freePort();
  const provider = (m: MockIdp, name: string) => ({
    enabled: true,
    clientId: m.clientId,
    clientSecret: m.clientSecret,
    redirectUri: `http://127.0.0.1:${port}/auth/${name}/callback`,
    issuer: m.issuer,
    scope: 'openid profile',
  });
  const configOverride: DeepPartial<Config> = {
    ...override,
    time: { scale: 0, ...override.time },
    // Every client dials from 127.0.0.1; a starved limiter would fail later subtests for
    // reasons unrelated to what they assert.
    limits: { maxConnsPerIp: 64, loginPerMinPerIp: 600, ...override.limits },
    auth: {
      allowPasswordLogin: true,
      returnUrl: RETURN_URL,
      ...override.auth,
      custom: { ...provider(idp, 'custom'), ...override.auth?.custom },
      google: { ...provider(idp2, 'google'), ...override.auth?.google },
    },
  };
  const server = await startServer({ requireGameData: false, dataDir, port, host: '127.0.0.1', configOverride });
  t.after(async () => {
    await server.close();
    await idp.stop();
    await idp2.stop();
  });
  return { server, idp, idp2, dataDir, base: `http://127.0.0.1:${server.port}` };
}

function cookieOf(res: Response): string {
  for (const c of res.headers.getSetCookie()) {
    const m = /^omwmp_oauth=([^;]*)/.exec(c);
    if (m && m[1] !== undefined && m[1] !== '') return decodeURIComponent(m[1]);
  }
  return '';
}

function fragment(location: string | null): URLSearchParams {
  const hash = (location ?? '').indexOf('#');
  return new URLSearchParams(hash === -1 ? '' : (location ?? '').slice(hash + 1));
}

// GET /auth/<provider>/start, returning the provider authorize URL and the state cookie.
async function startFlow(h: Harness, provider: string, qs = ''): Promise<{ authorize: URL; cookie: string; res: Response }> {
  const res = await fetch(`${h.base}/auth/${provider}/start${qs}`, { redirect: 'manual' });
  const location = res.headers.get('location') ?? '';
  return { authorize: new URL(location.startsWith('http') ? location : 'http://unset.invalid'), cookie: cookieOf(res), res };
}

async function callback(h: Harness, provider: string, code: string, state: string, cookie: string): Promise<Response> {
  return fetch(`${h.base}/auth/${provider}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
    redirect: 'manual',
    headers: cookie === '' ? {} : { cookie: `omwmp_oauth=${encodeURIComponent(cookie)}` },
  });
}

// The whole browser half: start -> provider -> callback. Returns the login ticket, or the
// error code the callback put in the fragment.
async function ssoLogin(
  h: Harness,
  spec: CodeSpec,
  provider = 'custom',
  idp = h.idp,
): Promise<{ ticket?: string; error?: string; link?: string; location: string }> {
  const { authorize, cookie } = await startFlow(h, provider);
  const code = idp.issueCode(authorize, spec);
  const res = await callback(h, provider, code, authorize.searchParams.get('state') ?? '', cookie);
  const location = res.headers.get('location') ?? '';
  const frag = fragment(location);
  return {
    ...(frag.get('mpticket') ? { ticket: frag.get('mpticket')! } : {}),
    ...(frag.get('mperror') ? { error: frag.get('mperror')! } : {}),
    ...(frag.get('mplink') ? { link: frag.get('mplink')! } : {}),
    location,
  };
}

// Redeems a ticket over the real WebSocket and returns the Welcome (or the disconnect).
async function joinWithTicket(h: Harness, ticket: string): Promise<{ client: TestClient; welcome: Record<string, unknown> }> {
  const c = await TestClient.connect(h.server.port);
  c.hello();
  await c.waitJson('SessionHelloOk');
  c.sendJson({ t: 'SessionLoginTicket', ticket });
  const welcome = await c.waitJson('SessionWelcome');
  c.sendJson({ t: 'SessionReady' });
  await c.waitEvent('PlayerList');
  return { client: c, welcome };
}

async function refuseTicket(h: Harness, ticket: string, code: string): Promise<void> {
  const c = await TestClient.connect(h.server.port);
  c.hello();
  await c.waitJson('SessionHelloOk');
  c.sendJson({ t: 'SessionLoginTicket', ticket });
  await c.waitDisconnect(code);
  c.close();
}

async function accountNames(dataDir: string): Promise<string[]> {
  try {
    // Accounts are rows in accounts.db now. Kept in the ".json" shape so the assertions below
    // still read as "which accounts exist"; only the source of truth changed.
    const db = new DatabaseSync(join(dataDir, 'accounts.db'));
    try {
      return (db.prepare('SELECT key FROM accounts').all() as { key: string }[])
        .map((r) => `${r.key}.json`).sort();
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

// The player's display name, read back the way any other client would see it.
async function onlineNames(h: Harness): Promise<string[]> {
  const res = await fetch(`${h.base}/status`);
  const body = (await res.json()) as { players: { name: string }[] };
  return body.players.map((p) => p.name).sort();
}

// -------------------------------------------------------------------- tests

test('a full authorization-code + PKCE round trip creates an account and logs in', async (t) => {
  const h = await boot(t);

  await t.test('the authorize request is code+PKCE(S256)+state+nonce, never implicit', async () => {
    const { authorize, cookie, res } = await startFlow(h, 'custom');
    assert.equal(res.status, 302);
    assert.equal(authorize.origin, h.idp.issuer);
    assert.equal(authorize.pathname, '/authorize');
    assert.equal(authorize.searchParams.get('response_type'), 'code'); // never "token"/"id_token"
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256'); // never "plain"
    assert.equal((authorize.searchParams.get('code_challenge') ?? '').length, 43); // sha256, base64url
    assert.ok((authorize.searchParams.get('state') ?? '').length >= 43, 'state must be high entropy');
    assert.ok((authorize.searchParams.get('nonce') ?? '').length >= 16, 'an OIDC request must carry a nonce');
    assert.equal(authorize.searchParams.get('client_id'), h.idp.clientId);
    assert.equal(authorize.searchParams.get('scope'), 'openid profile'); // no email scope, ever
    // The verifier must NOT be in the redirect: it is the half of PKCE that stays server-side.
    assert.equal(authorize.searchParams.get('code_verifier'), null);
    // The state cookie is the CSRF binding and must be unreadable from script.
    assert.ok(cookie.length >= 43);
    const raw = res.headers.getSetCookie().find((c) => c.startsWith('omwmp_oauth='))!;
    assert.match(raw, /HttpOnly/);
    assert.match(raw, /SameSite=Lax/);
    assert.match(raw, /Path=\/auth/);
  });

  await t.test('the callback exchanges the code server-side and hands back a ticket', async () => {
    const before = h.idp.tokenRequests;
    const out = await ssoLogin(h, { sub: 'sub-alpha', nameHint: 'Nerevarine', email: 'first@example.com' });
    assert.equal(h.idp.tokenRequests, before + 1, 'the code exchange happens on the server, once');
    assert.ok(out.ticket, `expected a ticket, got ${out.location}`);
    // The ticket travels in the FRAGMENT, so it is never logged or sent in a Referer, and
    // no provider token is anywhere near the browser.
    assert.ok(out.location.startsWith(`${RETURN_URL}#`), out.location);
    assert.ok(!out.location.includes('mock-access-token'));
    assert.ok(!/[?&]mpticket=/.test(out.location), 'the ticket must not be a query parameter');

    const { client, welcome } = await joinWithTicket(h, out.ticket!);
    assert.equal(typeof welcome['sessionToken'], 'string');
    assert.deepEqual(await onlineNames(h), ['Nerevarine']);
    assert.deepEqual(await accountNames(h.dataDir), ['nerevarine.json']);
    client.close();
  });
});

test('identities are keyed on (iss,sub), never on email', async (t) => {
  const h = await boot(t);
  const first = await ssoLogin(h, { sub: 'sub-stable', nameHint: 'Player One', email: 'before@example.com' });
  assert.ok(first.ticket, first.location);
  const a = await joinWithTicket(h, first.ticket!);
  const name = (await onlineNames(h))[0]!;
  a.client.close();
  await a.client.closed;

  await t.test('a second login for the same sub returns the SAME account even as the email changes', async () => {
    // Different email, different display-name claim: neither may fork the account.
    const again = await ssoLogin(h, { sub: 'sub-stable', nameHint: 'Renamed Player', email: 'after@example.com' });
    assert.ok(again.ticket, again.location);
    const b = await joinWithTicket(h, again.ticket!);
    assert.deepEqual(await onlineNames(h), [name], 'the same subject must land on the same account');
    assert.deepEqual(await accountNames(h.dataDir), [`${name.toLowerCase()}.json`], 'no second account was created');
    b.client.close();
    await b.client.closed;
  });

  await t.test('a different sub is a different account, even with an identical email', async () => {
    const other = await ssoLogin(h, { sub: 'sub-other', nameHint: 'Player Two', email: 'before@example.com' });
    assert.ok(other.ticket, other.location);
    const c = await joinWithTicket(h, other.ticket!);
    assert.deepEqual(await onlineNames(h), ['Player Two']);
    assert.equal((await accountNames(h.dataDir)).length, 2);
    c.client.close();
    await c.client.closed;
  });

  await t.test('a display-name claim that collides gets a suffix, never the other account', async () => {
    const collide = await ssoLogin(h, { sub: 'sub-collide', nameHint: name });
    assert.ok(collide.ticket, collide.location);
    const d = await joinWithTicket(h, collide.ticket!);
    const online = (await onlineNames(h))[0]!;
    assert.notEqual(online, name);
    assert.match(online, new RegExp(`^${name}-\\d+$`));
    d.client.close();
    await d.client.closed;
  });

  await t.test('an email-shaped name claim is never used as a display name', async () => {
    const e = await ssoLogin(h, { sub: 'sub-emailname', nameHint: 'someone@example.com' });
    assert.ok(e.ticket, e.location);
    const j = await joinWithTicket(h, e.ticket!);
    const online = (await onlineNames(h))[0]!;
    assert.ok(!online.includes('@') && !online.toLowerCase().includes('someone'), `leaked the email: ${online}`);
    assert.match(online, /^User-[0-9a-f]{6}$/);
    j.client.close();
    await j.client.closed;
  });
});

test('a bad ID token is refused on every axis', async (t) => {
  const h = await boot(t);
  const cases: [string, CodeSpec][] = [
    ['tampered signature', { sub: 'bad-1', badSignature: true }],
    ['expired', { sub: 'bad-2', expDelta: -3600 }],
    ['wrong audience', { sub: 'bad-3', aud: 'someone-elses-client' }],
    ['wrong issuer', { sub: 'bad-4', iss: 'https://evil.example' }],
    ['nonce mismatch', { sub: 'bad-5', nonce: 'not-the-nonce-we-sent' }],
    ['alg none', { sub: 'bad-6', alg: 'none', badSignature: true }],
  ];
  for (const [what, spec] of cases) {
    await t.test(`${what} is rejected`, async () => {
      const out = await ssoLogin(h, spec);
      assert.equal(out.ticket, undefined, `${what} must not yield a ticket`);
      assert.equal(out.error, 'idtoken', `${what}: ${out.location}`);
    });
  }
  await t.test('no account was created by any of them', async () => {
    assert.deepEqual(await accountNames(h.dataDir), []);
  });
});

test('the state parameter is enforced against the browser cookie', async (t) => {
  const h = await boot(t);

  await t.test('a callback with no cookie is refused', async () => {
    const { authorize } = await startFlow(h, 'custom');
    const code = h.idp.issueCode(authorize, { sub: 'state-1' });
    const res = await callback(h, 'custom', code, authorize.searchParams.get('state') ?? '', '');
    assert.equal(fragment(res.headers.get('location')).get('mperror'), 'state');
  });

  await t.test('a callback whose cookie belongs to another flow is refused', async () => {
    const a = await startFlow(h, 'custom');
    const b = await startFlow(h, 'custom');
    const code = h.idp.issueCode(a.authorize, { sub: 'state-2' });
    const res = await callback(h, 'custom', code, a.authorize.searchParams.get('state') ?? '', b.cookie);
    assert.equal(fragment(res.headers.get('location')).get('mperror'), 'state');
  });

  await t.test('an unknown state is refused', async () => {
    const res = await callback(h, 'custom', 'whatever', 'made-up-state', 'made-up-state');
    assert.equal(fragment(res.headers.get('location')).get('mperror'), 'state');
  });

  await t.test('replaying a completed callback is refused (state is single use)', async () => {
    const { authorize, cookie } = await startFlow(h, 'custom');
    const state = authorize.searchParams.get('state') ?? '';
    const first = await callback(h, 'custom', h.idp.issueCode(authorize, { sub: 'state-3' }), state, cookie);
    assert.ok(fragment(first.headers.get('location')).get('mpticket'));
    const replay = await callback(h, 'custom', h.idp.issueCode(authorize, { sub: 'state-3' }), state, cookie);
    assert.equal(fragment(replay.headers.get('location')).get('mperror'), 'state');
  });

  await t.test('a state minted for one provider cannot be redeemed at another', async () => {
    const { authorize, cookie } = await startFlow(h, 'custom');
    const code = h.idp.issueCode(authorize, { sub: 'state-4' });
    const res = await callback(h, 'google', code, authorize.searchParams.get('state') ?? '', cookie);
    assert.equal(fragment(res.headers.get('location')).get('mperror'), 'state');
  });

  await t.test('a provider error response never becomes a login', async () => {
    const { cookie } = await startFlow(h, 'custom');
    const res = await fetch(`${h.base}/auth/custom/callback?error=access_denied&state=x`, {
      redirect: 'manual',
      headers: { cookie: `omwmp_oauth=${cookie}` },
    });
    assert.equal(fragment(res.headers.get('location')).get('mperror'), 'provider_refused');
  });
});

test('login tickets are single use, short lived and unguessable', async (t) => {
  const h = await boot(t);

  await t.test('a ticket works exactly once', async () => {
    const out = await ssoLogin(h, { sub: 'ticket-1', nameHint: 'Ticketed' });
    assert.ok(out.ticket, out.location);
    const { client } = await joinWithTicket(h, out.ticket!);
    await refuseTicket(h, out.ticket!, 'AUTH_FAILED'); // second redemption
    client.close();
    await client.closed;
  });

  await t.test('a guessed or malformed ticket is refused, and does not cost the account', async () => {
    for (const bogus of [randomBytes(32).toString('base64url'), 'x', '']) {
      await refuseTicket(h, bogus, 'AUTH_FAILED');
    }
  });

  await t.test('tickets carry 256 bits and never repeat', async () => {
    const seen = new Set<string>();
    const store = new LoginTicketStore();
    for (let i = 0; i < 200; i++) {
      const ticket = store.mint('someone', 'Someone');
      assert.ok(ticket.length >= 43, `ticket too short: ${ticket.length}`);
      assert.match(ticket, /^[A-Za-z0-9_-]+$/);
      assert.ok(!seen.has(ticket), 'a repeated ticket would be a broken RNG');
      seen.add(ticket);
    }
    store.clear();
  });

  await t.test('an expired ticket cannot be claimed', async () => {
    const store = new LoginTicketStore(5); // 5 ms, so the test does not sit for a minute
    const ticket = store.mint('someone', 'Someone');
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(store.claim(ticket), undefined);
    store.clear();
  });
});

test('a banned account is refused through the SSO path', async (t) => {
  const h = await boot(t, { admin: { owners: ['Owner'] } });
  // An owner with a password account does the banning — the ordinary M8 path.
  const owner = await TestClient.connect(h.server.port);
  await owner.joinAsNew('Owner');
  await owner.waitEvent('PlayerList');
  await h.server.api.world.promoteOwner('Owner');

  const first = await ssoLogin(h, { sub: 'ban-me', nameHint: 'Troublemaker' });
  assert.ok(first.ticket, first.location);
  const joined = await joinWithTicket(h, first.ticket!);
  joined.client.close();
  await joined.client.closed;

  // A ticket minted BEFORE the ban must still be refused when it is redeemed: the ban is
  // re-checked against the RESOLVED account, not against a client-supplied name.
  const stale = await ssoLogin(h, { sub: 'ban-me' });
  assert.ok(stale.ticket, stale.location);
  owner.sendEvent('ChatSend', { text: '/ban Troublemaker cheating' });
  await owner.waitEvent('ChatMessage', (v) => /banned/i.test((v as { text: string }).text));

  await t.test('an already-minted ticket is refused with BANNED at redemption', async () => {
    await refuseTicket(h, stale.ticket!, 'BANNED');
  });

  await t.test('a fresh SSO round trip is refused at the callback', async () => {
    const out = await ssoLogin(h, { sub: 'ban-me' });
    assert.equal(out.ticket, undefined);
    assert.equal(out.error, 'banned', out.location);
  });

  owner.close();
});

test('one account, several providers', async (t) => {
  const h = await boot(t);
  const first = await ssoLogin(h, { sub: 'multi-1', nameHint: 'Linker' });
  assert.ok(first.ticket, first.location);
  const { client, welcome } = await joinWithTicket(h, first.ticket!);
  const sessionToken = welcome['sessionToken'] as string;

  await t.test('linking requires a live game session', async () => {
    const res = await fetch(`${h.base}/auth/link/google`, { redirect: 'manual' });
    assert.equal(fragment(res.headers.get('location')).get('mperror'), 'not_signed_in');
    const bogus = await fetch(`${h.base}/auth/link/google?session=${randomBytes(16).toString('hex')}`, { redirect: 'manual' });
    assert.equal(fragment(bogus.headers.get('location')).get('mperror'), 'not_signed_in');
  });

  await t.test('a second provider links to the same account and then logs into it', async () => {
    const start = await fetch(`${h.base}/auth/link/google?session=${sessionToken}`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const authorize = new URL(start.headers.get('location')!);
    assert.equal(authorize.origin, h.idp2.issuer);
    const code = h.idp2.issueCode(authorize, { sub: 'google-sub-1', nameHint: 'Some Other Name' });
    const done = await callback(h, 'google', code, authorize.searchParams.get('state') ?? '', cookieOf(start));
    assert.equal(fragment(done.headers.get('location')).get('mplink'), 'google');

    // Now log in through the freshly linked provider: same account, no new one.
    client.close();
    await client.closed;
    const viaGoogle = await ssoLogin(h, { sub: 'google-sub-1' }, 'google', h.idp2);
    assert.ok(viaGoogle.ticket, viaGoogle.location);
    const back = await joinWithTicket(h, viaGoogle.ticket!);
    assert.deepEqual(await onlineNames(h), ['Linker']);
    assert.deepEqual(await accountNames(h.dataDir), ['linker.json']);
    back.client.close();
    await back.client.closed;
  });

  await t.test('an identity already owned by someone else cannot be linked away', async () => {
    // A second player, with their own Google identity.
    const other = await ssoLogin(h, { sub: 'multi-2', nameHint: 'Bystander' });
    assert.ok(other.ticket, other.location);
    const session2 = (await joinWithTicket(h, other.ticket!)) as { client: TestClient; welcome: Record<string, unknown> };
    const token2 = session2.welcome['sessionToken'] as string;

    const start = await fetch(`${h.base}/auth/link/google?session=${token2}`, { redirect: 'manual' });
    const authorize = new URL(start.headers.get('location')!);
    const code = h.idp2.issueCode(authorize, { sub: 'google-sub-1' }); // already Linker's
    const done = await callback(h, 'google', code, authorize.searchParams.get('state') ?? '', cookieOf(start));
    assert.equal(fragment(done.headers.get('location')).get('mperror'), 'link_conflict');

    // And the victim's identity still points where it did.
    const viaGoogle = await ssoLogin(h, { sub: 'google-sub-1' }, 'google', h.idp2);
    assert.ok(viaGoogle.ticket);
    session2.client.close();
    await session2.client.closed;
    const back = await joinWithTicket(h, viaGoogle.ticket!);
    assert.deepEqual(await onlineNames(h), ['Linker']);
    back.client.close();
    await back.client.closed;
  });

  await t.test('a session token stops working for linking once the socket is gone', async () => {
    const res = await fetch(`${h.base}/auth/link/google?session=${sessionToken}`, { redirect: 'manual' });
    assert.equal(fragment(res.headers.get('location')).get('mperror'), 'not_signed_in');
  });
});

test('password login is unaffected, and cannot be used against an SSO-only account', async (t) => {
  const h = await boot(t);

  await t.test('register + login with a password still work', async () => {
    const a = await TestClient.connect(h.server.port);
    await a.joinAsNew('Oldschool', 'hunter22');
    await a.waitEvent('PlayerList');
    a.close();
    await a.closed;
    const b = await TestClient.connect(h.server.port);
    b.hello();
    await b.waitJson('SessionHelloOk');
    b.login('Oldschool', 'hunter22');
    await b.waitJson('SessionWelcome');
    b.close();
    await b.closed;
  });

  await t.test('an SSO-only account refuses a password login cleanly', async () => {
    const out = await ssoLogin(h, { sub: 'pw-1', nameHint: 'Passwordless' });
    assert.ok(out.ticket, out.location);
    const { client } = await joinWithTicket(h, out.ticket!);
    client.close();
    await client.closed;
    for (const password of ['', 'hunter22', 'anything']) {
      const c = await TestClient.connect(h.server.port);
      c.hello();
      await c.waitJson('SessionHelloOk');
      c.login('Passwordless', password);
      // AUTH_FAILED, not an internal error: an absent pwHash must not throw into argon2.
      const msg = await c.waitDisconnect('AUTH_FAILED');
      assert.match(String(msg['detail']), /unknown account or wrong password/);
      c.close();
    }
  });
});

test('requireSso forces SSO-only: register AND password login are both refused', async (t) => {
  const h = await boot(t, { auth: { requireSso: true } });

  const c = await TestClient.connect(h.server.port);
  c.hello();
  await c.waitJson('SessionHelloOk');
  c.register('Someone', 'hunter22');
  const reg = await c.waitDisconnect('AUTH_FAILED');
  assert.match(String(reg['detail']), /single sign-on/, 'register is refused and points at SSO');
  c.close();

  const c2 = await TestClient.connect(h.server.port);
  c2.hello();
  await c2.waitJson('SessionHelloOk');
  c2.login('Someone', 'hunter22');
  const log = await c2.waitDisconnect('AUTH_FAILED');
  assert.match(String(log['detail']), /single sign-on/, 'password login is refused too');
  c2.close();

  // ...and SSO still lets you in.
  const out = await ssoLogin(h, { sub: 'require-sso-1', nameHint: 'Legit' });
  assert.ok(out.ticket, out.location);
  const { client } = await joinWithTicket(h, out.ticket!);
  assert.deepEqual(await onlineNames(h), ['Legit']);
  client.close();
});

test('an SSO-only server can turn the password path off', async (t) => {
  const h = await boot(t, { auth: { allowPasswordLogin: false } });

  await t.test('password login is refused', async () => {
    const c = await TestClient.connect(h.server.port);
    c.hello();
    await c.waitJson('SessionHelloOk');
    c.login('Anyone', 'hunter22');
    const msg = await c.waitDisconnect('AUTH_FAILED');
    assert.match(String(msg['detail']), /password login is disabled|single sign-on/);
    c.close();
  });

  await t.test('SSO still works', async () => {
    const out = await ssoLogin(h, { sub: 'sso-only-1', nameHint: 'Modern' });
    assert.ok(out.ticket, out.location);
    const { client } = await joinWithTicket(h, out.ticket!);
    assert.deepEqual(await onlineNames(h), ['Modern']);
    client.close();
  });

  await t.test('/auth/providers advertises what this server accepts', async () => {
    const res = await fetch(`${h.base}/auth/providers`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { providers: string[]; allowPasswordLogin: boolean };
    assert.deepEqual(body.providers.sort(), ['custom', 'google']);
    assert.equal(body.allowPasswordLogin, false);
  });
});

test('SSO respects the server registration policy', async (t) => {
  await t.test('a closed server creates no account for an unknown identity', async (tt) => {
    const h = await boot(tt, { login: { allowRegistration: false } });
    const out = await ssoLogin(h, { sub: 'closed-1', nameHint: 'Uninvited' });
    assert.equal(out.error, 'registration_disabled', out.location);
    assert.deepEqual(await accountNames(h.dataDir), []);
  });

  await t.test('an invite-only server requires the invite through SSO too', async (tt) => {
    const h = await boot(tt, { login: { inviteCode: 'letmein' } });
    const without = await ssoLogin(h, { sub: 'invite-1', nameHint: 'NoInvite' });
    assert.equal(without.error, 'invite_required', without.location);

    const { authorize, cookie } = await startFlow(h, 'custom', '?invite=letmein');
    const code = h.idp.issueCode(authorize, { sub: 'invite-2', nameHint: 'Invited' });
    const res = await callback(h, 'custom', code, authorize.searchParams.get('state') ?? '', cookie);
    assert.ok(fragment(res.headers.get('location')).get('mpticket'), res.headers.get('location') ?? '');
    assert.deepEqual(await accountNames(h.dataDir), ['invited.json']);
  });
});

test('the /auth routes do not disturb the rest of the HTTP surface', async (t) => {
  const h = await boot(t, { metrics: { enabled: true, token: 'scrape-me' } });

  await t.test('/status is still public, CORS-enabled JSON', async () => {
    const res = await fetch(`${h.base}/status`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const body = (await res.json()) as { name: string; version: string };
    assert.equal(typeof body.name, 'string');
    assert.equal(typeof body.version, 'string');
  });

  await t.test('/healthz still answers ok', async () => {
    assert.equal(await (await fetch(`${h.base}/healthz`)).text(), 'ok');
  });

  await t.test('/metrics is still bearer-gated with no CORS header', async () => {
    assert.equal((await fetch(`${h.base}/metrics`)).status, 401);
    const ok = await fetch(`${h.base}/metrics`, { headers: { authorization: 'Bearer scrape-me' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), null);
    assert.match(await ok.text(), /omwmp_/);
  });

  await t.test('unknown and non-GET auth paths are 404, not 500', async () => {
    assert.equal((await fetch(`${h.base}/auth`)).status, 404);
    assert.equal((await fetch(`${h.base}/auth/nope/start`, { redirect: 'manual' })).status, 302); // -> #mperror
    assert.equal(fragment((await fetch(`${h.base}/auth/nope/start`, { redirect: 'manual' })).headers.get('location')).get('mperror'), 'unknown_provider');
    assert.equal((await fetch(`${h.base}/auth/custom/start`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${h.base}/nonsense`)).status, 404);
  });

  await t.test('a disabled provider never redirects anywhere', async () => {
    const res = await fetch(`${h.base}/auth/discord/start`, { redirect: 'manual' });
    assert.equal(fragment(res.headers.get('location')).get('mperror'), 'provider_disabled');
  });
});
