// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s106: THE FRONT DOOR — the first thing every real player does, which nothing tested.
//
// Every other browser scenario boots index.html with &mpauto=1, a fixed public password that
// registers over the wire. That is a side door built for tests. A person handed the server
// address lands on launcher.html, presses Sign in, and types a username and a password — and
// no scenario has ever loaded launcher.html at all.
//
// That gap had a cost. The multiplayer door was shut on a correctly configured server: the
// launcher read only the `providers` array from /auth/providers and ignored allowPasswordLogin
// sitting beside it, so a password server showed three greyed-out "Soon" buttons and told the
// player to ask the operator to enable a sign-in method the operator had already enabled. Every
// test passed throughout, because every test came in the side door.
//
// So this one uses the front door, with an account created the way a friend's account is really
// created: by the operator, from the dashboard, as a PLAYER with no dashboard access.
import assert from 'node:assert/strict';

const OWNER = { name: 'frontdoor-owner@example.com', password: 'a-long-enough-passphrase' };
const PLAYER = { name: 'frontdoor-friend@example.com', password: 'another-long-passphrase' };

export default async function run(ctx) {
  const base = `http://127.0.0.1:${ctx.serverPort}`;

  // The operator sets the server up and adds a friend. `role: ''` is a player: they can sign in
  // and play, and they get no dashboard. Before that option existed every friend an operator
  // added received a login to the admin dashboard.
  const owner = await fetch(`${base}/admin/api/setup/owner`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER),
  });
  // Read the body ONCE. An assert message is an ordinary expression and is evaluated whether
  // or not the assertion fails, so `${await owner.text()}` in the message consumed the body and
  // the .json() below died with "Body has already been read" -- a failure about the fixture,
  // not the server.
  const ownerBody = await owner.text();
  assert.equal(owner.status, 200, `owner creation (${owner.status}): ${ownerBody}`);
  const token = JSON.parse(ownerBody).token;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const made = await fetch(`${base}/admin/api/accounts/create`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: PLAYER.name, password: PLAYER.password, role: '' }),
  });
  const madeBody = await made.text();
  assert.equal(made.status, 200,
    `the operator must be able to add a PLAYER (${made.status}): ${madeBody}`);
  ctx.log('ok: the operator added a friend as a player, with no dashboard access');

  // A control worth having before touching the browser: the server really is a password server
  // with no SSO configured. That is the exact shape the launcher used to refuse.
  const providers = await (await fetch(`${base}/auth/providers`)).json();
  assert.equal(providers.allowPasswordLogin, true, 'this fixture is only meaningful on a password server');
  assert.deepEqual(providers.providers, [], 'and only when no SSO provider is configured');
  ctx.log(`ok: server offers password sign-in and ${providers.providers.length} SSO providers`);

  // THE FRONT DOOR. launcher.html, not index.html, and no &mpauto.
  // 8910 is play/server.py's fixed port (mp-harness PLAY_PORT): the launcher is served from
  // there, and ?mpserver points it at THIS scenario's server rather than the page's own origin.
  const page = await ctx.launchClient('frontdoor', '', {
    url: `http://127.0.0.1:8910/launcher.html`
      + `?mpserver=${encodeURIComponent(`ws://127.0.0.1:${ctx.serverPort}/ws`)}`,
    waitExpr: 'typeof mpStart === "function"',
    waitWhat: 'the launcher page loaded',
    noAuto: true,
  });

  await page.eval('window.__omwSignInIntent = "mp"; mpStart(); true');

  // 1. THE DOOR IS OPEN. Without the fix this box never renders and the player is told to go
  //    and ask the operator to enable something they had already enabled.
  await page.waitFor('!!document.getElementById("mp-pw-name")', 20_000,
    'the multiplayer sign-in must offer username and password on a password server');
  const note = await page.eval('(document.getElementById("mp-note")||{}).innerText||""');
  assert.doesNotMatch(String(note), /no sign-in provider/i,
    `the door must not dead-end: "${note}"`);
  ctx.log('ok: the multiplayer sign-in offers a username and password');

  // 2. THE CONTROL, FIRST. A wrong password must be refused and say so, or "it let me in"
  //    below is equally satisfied by a door that lets anybody through. Done before the
  //    successful sign-in because that one navigates the page onward.
  await page.eval(`document.getElementById('mp-pw-name').value = ${JSON.stringify(PLAYER.name)};
    document.getElementById('mp-pw-pass').value = 'not-the-right-password';
    document.getElementById('mp-pw-go').click(); true`);
  // NOT "the note is non-empty": the button sets it to "Signing in..." the instant it is
  // clicked, so that predicate is satisfied by the request being IN FLIGHT and would pass
  // against a server that never answered. Wait for a note that is not the in-progress one.
  await page.waitFor(
    '(function(){ var t = ((document.getElementById("mp-note")||{}).innerText||"").trim();'
    + ' return t.length > 0 && !/^signing in/i.test(t); })()',
    30_000, 'a wrong password must be refused out loud, not silently');
  const refusal = await page.eval('document.getElementById("mp-note").innerText');
  assert.match(String(refusal), /match|password|sign/i, `an unhelpful refusal: "${refusal}"`);
  assert.equal(await page.eval('!!(JSON.parse(sessionStorage.getItem("omw-mp-session")||"null")||{}).account'),
    false, 'a refused sign-in must not leave a session behind');
  ctx.log(`ok: a wrong password is refused — "${refusal}"`);

  // 3. AND THE RIGHT ONE LETS THEM IN. Same fragment handoff the SSO redirect uses, so
  //    character select and world dial-in stay one path rather than two that drift.
  await page.eval(`document.getElementById('mp-pw-name').value = ${JSON.stringify(PLAYER.name)};
    document.getElementById('mp-pw-pass').value = ${JSON.stringify(PLAYER.password)};
    document.getElementById('mp-pw-go').click(); true`);

  // The page reloads itself with #mpticket, exactly as it does coming back from a provider, and
  // handleSsoReturn stores the session. THAT is the signal, not the onboarding modal: whether
  // onboarding appears depends on [login] requireProfile, which the wizard sets and this fixture
  // never runs -- so asserting on the modal would be asserting on a setting, not on sign-in.
  await page.waitFor(
    '!!(JSON.parse(sessionStorage.getItem("omw-mp-session")||"null")||{}).account',
    60_000,
    'signing in must produce a session — the same handoff the SSO redirect lands on');
  const acct = await page.eval('JSON.parse(sessionStorage.getItem("omw-mp-session")).account');
  assert.equal(String(acct).toLowerCase(), PLAYER.name.toLowerCase(),
    `the session must belong to the account that signed in, got ${acct}`);
  ctx.log(`ok: signed in through the front door as ${acct}`);

  ctx.log('PASS: a player signs in at the front door with a username and a password');
}
