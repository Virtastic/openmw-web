// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s176: THE INVITE LINK, THROUGH THE FRONT DOOR, THROUGH A REAL SSO ROUND TRIP.
//
// An invite-only server hands a new player https://<server>/?invite=<code>. The page they land
// on (server/web/play.js) must put that code on every provider link and never ask them to type
// a passphrase; the provider round trip then carries it to the callback, which checks it when
// the sign-in would CREATE an account. A wrong code comes back as #mperror=invite_required and
// must be FORGOTTEN, or every retry from that page sends the same wrong code again.
//
// auth.test.ts proves the callback against a fake IdP over fetch(). Nothing proved the page:
// that the link the dashboard hands out survives the page, the click, the provider hop and the
// return. So this runs the same kind of fake IdP inside the harness, auto-consenting, and a
// real browser clicks "Continue with Google" (the provider id the page draws; its issuer points
// at the fake).
//
// The IdP must be listening before the server's config is written, and serverRules is read at
// import time -- so it starts at module load on a fixed port, and the redirect it answers with
// goes through its own /cb hop, which forwards to the scenario's server once run() knows the
// port. The state cookie is host-scoped (cookies ignore ports), so it rides both hops.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const IDP_PORT = 19221; // clear of the gateway band (18860..19150 +10 steps, worlds at +2000)
const ISSUER = `http://127.0.0.1:${IDP_PORT}`;
const CLIENT_ID = 's176-client', CLIENT_SECRET = 's176-secret';
const RIGHT = 'river-otter-lantern';
const STEP = 30_000;

// ---- the fake provider (auth.test.ts MockIdp, minus the knobs, plus auto-consent) ----------
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 's176', alg: 'RS256', use: 'sig' };
const codes = new Map();
const idp = { serverPort: 0, authorizes: 0, subSeq: 0 };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(p) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'RS256', typ: 'JWT', kid: 's176' })}.${b64({
    iss: ISSUER, sub: p.sub, aud: CLIENT_ID, iat: now, exp: now + 600, nonce: p.nonce,
    preferred_username: p.name })}`;
  return `${body}.${sign('sha256', Buffer.from(body), privateKey).toString('base64url')}`;
}
const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', ISSUER);
  const json = (c, b) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (url.pathname === '/.well-known/openid-configuration') {
    return json(200, { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
  }
  if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
  if (url.pathname === '/authorize') {
    // The consent screen, clicked instantly: a new identity each time, so every sign-in is a
    // NEW account and the invite is actually checked.
    idp.authorizes++;
    const code = randomBytes(12).toString('hex');
    const n = ++idp.subSeq;
    codes.set(code, { sub: `s176-sub-${n}`, name: `invitee${n}`,
      challenge: url.searchParams.get('code_challenge'), nonce: url.searchParams.get('nonce'),
      redirectUri: url.searchParams.get('redirect_uri') });
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') ?? '');
    res.writeHead(302, { location: back.href }); return res.end();
  }
  if (url.pathname === '/cb') {
    // The registered redirect URI. Forward to the server under test, same query.
    res.writeHead(302, { location: `http://127.0.0.1:${idp.serverPort}/auth/google/callback${url.search}` });
    return res.end();
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const f = new URLSearchParams(raw);
      const p = codes.get(f.get('code') ?? '');
      codes.delete(f.get('code') ?? '');
      if (!p) return json(400, { error: 'invalid_grant' });
      if (f.get('client_id') !== CLIENT_ID || f.get('client_secret') !== CLIENT_SECRET) return json(401, { error: 'invalid_client' });
      if (f.get('redirect_uri') !== p.redirectUri) return json(400, { error: 'invalid_redirect' });
      if (createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') !== p.challenge) return json(400, { error: 'pkce' });
      json(200, { access_token: 'x', token_type: 'Bearer', id_token: idToken(p) });
    });
    return;
  }
  json(404, { error: 'not_found' });
});
http.on('error', () => { /* a suite scan imports every scenario; a second import must not die */ });
http.listen(IDP_PORT, '127.0.0.1');
http.unref();

export const serverRules = [
  '[setup]', 'completed = true', 'deploymentMode = "multiplayer"',
  '[login]', `inviteCode = "${RIGHT}"`, 'allowRegistration = true',
  '[auth]', 'allowPasswordLogin = true', 'returnUrl = ""',
  '[auth.google]', 'enabled = true', `clientId = "${CLIENT_ID}"`, `clientSecret = "${CLIENT_SECRET}"`,
  `redirectUri = "${ISSUER}/cb"`, `issuer = "${ISSUER}"`, 'scope = "openid profile"',
].join('\n');

const OWNER = { name: 'invite-owner@example.com', password: 'a-long-enough-passphrase' };

export default async function run(ctx) {
  idp.serverPort = ctx.serverPort;
  const base = `http://127.0.0.1:${ctx.serverPort}`;
  const owner = await fetch(`${base}/admin/api/setup/owner`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER) });
  const ownerBody = await owner.text();
  assert.equal(owner.status, 200, `owner creation (${owner.status}): ${ownerBody}`);
  const admin = { authorization: `Bearer ${JSON.parse(ownerBody).token}` };
  const accounts = async () => (await (await fetch(`${base}/admin/api/accounts`, { headers: admin })).json());
  const newAccounts = async () => ((await accounts()).accounts ?? []).filter((a) => a.name.toLowerCase() !== OWNER.name);

  const prov = await (await fetch(`${base}/auth/providers`)).json();
  assert.equal(prov.inviteRequired, true, `the fixture must be an invite-only server: ${JSON.stringify(prov)}`);
  assert.ok((prov.providers ?? []).includes('google'), `google must be offered: ${JSON.stringify(prov)}`);

  // What the page shows, read in one eval (every eval costs a frame; this page has no engine,
  // but the habit is cheap).
  const read = `JSON.stringify({
      links: [...document.querySelectorAll('a.prov')].map((a) => a.href),
      inputs: [...document.querySelectorAll('input')].map((i) => [i.id, i.name, i.type, i.placeholder].join('|')),
      note: (document.getElementById('note') || {}).hidden ? '' : ((document.getElementById('note') || {}).innerText || ''),
      stored: sessionStorage.getItem('omwmp:invite'), path: location.pathname, hash: location.hash })`;
  const pageReady = '!!document.querySelector("a.prov")';

  // 1. THE LINK. /?invite=<right code>: every provider link carries it, no passphrase box.
  const page = await ctx.launchClient('invitee', '', {
    url: `${base}/?invite=${encodeURIComponent(RIGHT)}`, noAuto: true,
    waitExpr: pageReady, waitWhat: 'the front door drew its provider links', expectStuckLoading: true });
  let s = JSON.parse(await page.eval(read));
  ctx.log(`front door with the link: ${JSON.stringify(s)}`);
  assert.ok(s.links.length > 0, 'no provider links drawn');
  for (const l of s.links) assert.equal(new URL(l).searchParams.get('invite'), RIGHT, `a provider link lost the invite: ${l}`);
  const typed = s.inputs.filter((i) => /invite|passphrase|code/i.test(i));
  assert.deepEqual(typed, [], `the page asks the player to type the invite: ${JSON.stringify(s.inputs)}`);
  assert.doesNotMatch(s.note, /invite-only/i, `the invited player is told the server is invite-only: "${s.note}"`);
  ctx.log('ok: the invite rides every provider link and there is no passphrase box');

  // 2. THE CONTROL: a WRONG code, through the same real click. Refused as invite_required, no
  //    account made, and the page FORGETS it -- both the stored copy and the links it draws.
  await page.eval(`location.href = ${JSON.stringify(`${base}/?invite=not-the-code`)}; 'nav'`);
  await page.waitFor(`${pageReady} && location.search.includes('not-the-code')`, STEP, 'the wrong-code page loaded');
  const before = idp.authorizes;
  ctx.log(`clicking: ${await page.click('a.prov')}`);
  await page.waitFor(`/mperror|invite-only/.test(location.hash + ((document.getElementById('note')||{}).innerText||''))`, STEP,
    'the round trip came back with a refusal');
  await page.waitFor(pageReady, STEP, 'the page redrew after the refusal');
  s = JSON.parse(await page.eval(read));
  ctx.log(`after the wrong code: ${JSON.stringify(s)} (authorizes ${before} -> ${idp.authorizes})`);
  assert.equal(idp.authorizes, before + 1, 'the click never reached the provider');
  assert.match(s.note, /invite-only/i, `the refusal must say why: "${s.note}"`);
  assert.equal((await newAccounts()).length, 0, 'a wrong invite created an account');
  assert.equal(s.stored, null, `the wrong invite is still stored: ${s.stored}`);
  const stale = s.links.filter((l) => new URL(l).searchParams.get('invite') === 'not-the-code');
  assert.deepEqual(stale, [], `a retry from this page would send the refused invite again: ${JSON.stringify(s.links)}`);
  ctx.log('ok: a wrong invite is refused, creates nothing, and is forgotten');

  // 3. THE RIGHT CODE: the same click lands a ticket and a new account.
  await page.eval(`location.href = ${JSON.stringify(`${base}/?invite=${encodeURIComponent(RIGHT)}`)}; 'nav'`);
  await page.waitFor(`${pageReady} && location.search.includes(${JSON.stringify(RIGHT)})`, STEP, 'the invite page loaded again');
  ctx.log(`clicking: ${await page.click('a.prov')}`);
  // Multiplayer front door: play.js hands the ticket to /join (#mpticket). The harness server
  // has no /join page, so the navigation itself -- with the ticket in the fragment -- is the signal.
  await page.waitFor(`location.pathname === '/join' && /mpticket=/.test(location.hash)`
    + ` || /player app/.test((document.getElementById('note')||{}).innerText||'')`, STEP,
    'signing in with the invite handed a ticket on to the game');
  const made = await newAccounts();
  ctx.log(`accounts created: ${JSON.stringify(made.map((a) => a.name))}; at ${await page.eval('location.pathname')}`);
  assert.equal(made.length, 1, `the invited sign-in must create exactly one account, got ${made.length}`);
  ctx.log('PASS: the invite link carried a new player through a real SSO round trip; a wrong one was refused and forgotten');
}
