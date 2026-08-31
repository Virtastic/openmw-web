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

import { renderCaddyfile } from '../src/net/admin/caddy-config';

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

test('the operator copy of Morrowind is refused before the file server runs', () => {
  const out = renderCaddyfile({ domain: '' });
  assert.match(out, /@private path .*\/mwdata\/\*/);
  assert.match(out, /respond "not found" 404/);
});

test('localhost keeps a site block even with a domain, so a typo cannot lock the operator out', () => {
  const out = renderCaddyfile({ domain: 'mp.example.test' });
  assert.match(out, /^localhost \{$/m);
  assert.match(out, /^mp\.example\.test \{$/m);
});
