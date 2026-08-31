// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The generated proxy config, pinned where getting it wrong is invisible until a human looks.
//
// This file had no test, and shipped without the cross-origin isolation headers. Nothing in
// the suite noticed, because every server-side check passes without them: the pages are
// served, the routes answer, /healthz is green. The failure is entirely inside the browser,
// where the engine asks for SharedArrayBuffer and the browser refuses, and it presents as
// "Browser not supported" on a perfectly capable Chrome.

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderCaddyfile, launcherEnabled } from '../src/net/admin/caddy-config';

// Without all three, the engine cannot start. This is the one assertion in the file that
// stands between a working install and a game that never boots.
const ISOLATION = [
  'Cross-Origin-Opener-Policy "same-origin"',
  'Cross-Origin-Embedder-Policy "require-corp"',
  'Cross-Origin-Resource-Policy "cross-origin"',
];

test('the localhost-only config is cross-origin isolated', () => {
  const out = renderCaddyfile({ domain: '' });
  for (const h of ISOLATION) assert.ok(out.includes(h), `missing: ${h}`);
});

test('BOTH site blocks are isolated when a domain is set', () => {
  // The domain block is the one real players arrive on, and the localhost block is how the
  // operator tests it. Isolating only one produces the worst version of this bug: it works
  // when the operator checks and fails for everybody else.
  const out = renderCaddyfile({ domain: 'mp.example.test' });
  for (const h of ISOLATION) {
    assert.equal(out.split(h).length - 1, 2, `expected ${h} in both site blocks`);
  }
});

test('the development scaffolding in the source tree is refused outright', () => {
  const out = renderCaddyfile({ domain: '' });
  assert.match(out, /@private path .*\/server\.py/);
  assert.match(out, /respond "not found" 404/);
});

test('/mwdata/* reaches the server rather than the folder in the source tree', () => {
  // play/mwdata is a developer's own copy of Morrowind and must never be served. It is not
  // denied here any more, because the same path is how the game page fetches an operator's
  // published library — so it is PROXIED instead, and the server decides. The ordering is
  // what keeps the source-tree folder unreachable: this handler is matched before the static
  // file server ever looks in /srv/client.
  const out = renderCaddyfile({ domain: '' });
  assert.match(out, /@mwdata path \/mwdata\/\* \/mwdata-manifest\.json \/mwdata-mods\.json/);
  assert.ok(out.indexOf('@mwdata') < out.indexOf('@static'),
    '@mwdata must be handled before the static root, or play/mwdata leaks');
});

test('localhost keeps a site block even with a domain, so a typo cannot lock the operator out', () => {
  const out = renderCaddyfile({ domain: 'mp.example.test' });
  assert.match(out, /^localhost \{$/m);
  assert.match(out, /^mp\.example\.test \{$/m);
});

// --- the launcher is opt-in ------------------------------------------------------------------
//
// play/launcher.html is the hosted site's chooser: bundled sample, your own local Morrowind,
// or multiplayer. None of those is a question for a player who came to THIS server, and "/"
// already signs them in and starts the game. Environment only, and off unless asked for.

test('the launcher is not served by default', () => {
  const out = renderCaddyfile({ domain: '' });
  assert.match(out, /@launcher path \/launcher\.html/);
  // Redirected, not refused: the game page falls back to the launcher on a fatal and on a
  // bootless load, and a 404 would strand a player at the worst possible moment.
  // The wildcard matcher is load-bearing, not noise: without it Caddy reads the "/" as a
  // path matcher and "302" as the destination, and the redirect silently never fires.
  assert.match(out, /redir \* \/ 302/);
});

test('and IS served when the environment asks for it', () => {
  const out = renderCaddyfile({ domain: '', launcher: true });
  assert.doesNotMatch(out, /@launcher/);
});

test('the gate applies to a domain deployment too, in both blocks', () => {
  const out = renderCaddyfile({ domain: 'mp.example.test' });
  assert.equal(out.split('@launcher path').length - 1, 2);
});

test('only an explicit truthy value switches it on', () => {
  // The default must be off, so an unset or empty variable cannot quietly expose it.
  for (const v of [undefined, '', ' ', '0', 'false', 'no', 'off']) {
    assert.equal(launcherEnabled(v === undefined ? {} : { OMW_ENABLE_LAUNCHER: v }), false, `"${v}"`);
  }
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' on ']) {
    assert.equal(launcherEnabled({ OMW_ENABLE_LAUNCHER: v }), true, `"${v}"`);
  }
});

// --- internal hosting is plain HTTP on a chosen port --------------------------------------------
//
// This mode used to serve a SELF-SIGNED certificate, which is the wrong answer for all three of
// its uses: a LAN browser shows a full-page warning, a forwarded port hands the internet a
// certificate nothing trusts, and an upstream reverse proxy has to be told to ignore one it
// should never have been offered. Whatever sits in front is where TLS belongs.

test('internal hosting serves plain HTTP, with no certificate anywhere', () => {
  const out = renderCaddyfile({ domain: '', internal: true, port: 8123 });
  assert.match(out, /^:8123 \{$/m, 'should listen on the chosen port');
  assert.doesNotMatch(out, /tls internal/, 'no self-signed certificate in this mode');
  assert.doesNotMatch(out, /^localhost \{$/m, 'no second HTTPS site');
  // Without this Caddy provisions a certificate for the site address and bounces plain
  // requests, which is exactly what a proxy or a LAN client must not meet.
  assert.match(out, /auto_https off/);
});

test('the port is honoured, and a fractional one cannot produce a broken address', () => {
  assert.match(renderCaddyfile({ domain: '', internal: true, port: 80 }), /^:80 \{$/m);
  assert.match(renderCaddyfile({ domain: '', internal: true, port: 8080.9 }), /^:8080 \{$/m);
});

test('internal still carries the isolation headers and the mod routes', () => {
  // The mode changes TLS and nothing else: the engine still needs cross-origin isolation, and
  // the game files still have to be reachable.
  const out = renderCaddyfile({ domain: '', internal: true, port: 8080 });
  for (const h of ISOLATION) assert.ok(out.includes(h), `missing: ${h}`);
  assert.match(out, /@mwdata path/);
});

test('public hosting is unchanged: a real certificate, and localhost as a way back in', () => {
  const out = renderCaddyfile({ domain: 'mp.example.test' });
  assert.match(out, /^mp\.example\.test \{$/m);
  assert.match(out, /^localhost \{$/m);
  assert.match(out, /tls internal/);
  assert.doesNotMatch(out, /auto_https off/, 'the public path must still provision certificates');
});
