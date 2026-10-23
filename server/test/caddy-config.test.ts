// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The generated proxy config, pinned where getting it wrong is invisible until a human looks.
//
// Since issue #203 the proxy is a plain HTTPS front: the server serves the player app, its
// isolation headers, /join and the deny list itself (test/client-routes.test.ts pins those).
// What is left here is the TLS posture and the one rule that everything reaches the server.

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderCaddyfile, launcherEnabled } from '../src/net/admin/caddy-config';

test('every site block hands everything to the server and serves nothing from disk', () => {
  for (const opts of [{ domain: '' }, { domain: 'mp.example.test' }, { domain: '', internal: true, port: 8080 }]) {
    const out = renderCaddyfile(opts);
    const blocks = out.split(/^\S[^\n]* \{$/m).length - 1;
    assert.ok(blocks >= 1);
    assert.equal(out.split('reverse_proxy openmw-web:8080').length - 1, blocks, JSON.stringify(opts));
    // A second set of rules here is how the two drifted: the server answered :8080 without the
    // player app while the proxy served it on :80.
    assert.doesNotMatch(out, /^\s*(file_server|root|rewrite|redir|handle|@\w+)\b/m, JSON.stringify(opts));
  }
});

test('a server nobody configured serves plain HTTP, not a certificate warning', () => {
  // First contact used to be a self-signed certificate and a browser interstitial, for
  // nothing: the dashboard needs no TLS, localhost is a secure context for the engine
  // anyway, and an unconfigured server refuses players. The wizard's hosting answer is
  // what sets the real posture.
  const out = renderCaddyfile({ domain: '' });
  assert.match(out, /^:80 \{$/m, 'the fresh default must answer on plain :80');
  // And https://localhost still answers, self-signed: a browser that remembers or auto-tries
  // https would otherwise show "site can't be reached", which reads as the server being down.
  assert.match(out, /^localhost \{$/m, 'https must keep answering for browsers that insist');
  assert.match(out, /tls internal/);
});

test('localhost keeps a site block even with a domain, so a typo cannot lock the operator out', () => {
  const out = renderCaddyfile({ domain: 'mp.example.test' });
  assert.match(out, /^localhost \{$/m);
  assert.match(out, /^mp\.example\.test \{$/m);
});

test('only an explicit truthy value switches the launcher on', () => {
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

test('public hosting is unchanged: a real certificate, and localhost as a way back in', () => {
  const out = renderCaddyfile({ domain: 'mp.example.test' });
  assert.match(out, /^mp\.example\.test \{$/m);
  assert.match(out, /^localhost \{$/m);
  assert.match(out, /tls internal/);
  assert.doesNotMatch(out, /auto_https off/, 'the public path must still provision certificates');
});
