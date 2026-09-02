// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The slower-burning findings from the pre-release audit, each with the check that fails
// without its fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IpRateLimiter } from '../src/net/ratelimit';
import { SocialStore } from '../src/core/socialstore';
import { saveKey } from '../src/data/save-routes';

// The overflow guard used to be `if (size > 10000) clear()`, which made the guard the BYPASS:
// 10,001 addresses wiped EVERY bucket at once, including the one throttling an attacker's
// brute force, and holding the map above the mark turned rate limiting off permanently.
// LRU eviction bounds the map without ever dropping the bucket of whoever is actually
// hammering us, because they are by definition the most recently used.
test('a flood of addresses does not reset the bucket of an active attacker', () => {
  const lim = new IpRateLimiter(5);
  const attacker = '203.0.113.9';
  for (let i = 0; i < 5; i++) assert.equal(lim.allow(attacker), true, `attempt ${i}`);
  assert.equal(lim.allow(attacker), false, 'the sixth attempt must be refused');

  // A real brute force keeps trying while it floods — that is what makes it a brute force.
  for (let i = 0; i < 20_000; i++) {
    lim.allow(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
    assert.equal(lim.allow(attacker), false, `the flood re-opened the door at ${i}`);
  }
});

// Nothing ever deleted a presence row, so goneLongerThan matched every account that had ever
// played, forever.
test('presence rows for the long gone are pruned', () => {
  const s = new SocialStore(':memory:');
  const now = Date.now();
  const old = now - 3 * 24 * 60 * 60 * 1000;
  s.setPresence('ancient', 'w', 'Ancient', 'cell', false, old);
  s.clearPresence('ancient', 'w', old);
  s.setPresence('recent', 'w', 'Recent', 'cell', false, now);
  s.clearPresence('recent', 'w', now - 60_000);

  assert.equal(s.prunePresence(now), 1, 'the ancient row was not reclaimed');
  assert.equal(s.presentEverywhere(now, 30_000).length, 0);
  // The recent departure must survive, or the disconnect sweep never sees it.
  assert.ok(s.goneLongerThan(now, 30_000).includes('recent'));
  assert.ok(!s.goneLongerThan(now, 30_000).includes('ancient'));
  s.close();
});

// A world process that dies HARD never runs clearPresence, so its occupants keep offline_since
// NULL with a frozen updated_at: hidden by the TTL, but the sweep never fired for them and
// their party survived a full day behind a leader who was never coming back.
test('occupants of a world that died without cleaning up are swept', () => {
  const s = new SocialStore(':memory:');
  const now = Date.now();
  s.setPresence('stranded', 'dead-world', 'Stranded', 'cell', false, now - 10 * 60_000);
  assert.equal(s.presentEverywhere(now, 30_000).length, 0, 'the TTL should already hide them');
  assert.ok(s.goneLongerThan(now, 30_000).includes('stranded'),
    'their party will sit behind a leader who is never coming back');
  s.close();
});

// scopeOf collapses anything unrecognised to 'mp', which IS the validation — a dead SCOPES
// allow-list used to sit beside it reading like the check.
test('a client-supplied scope cannot escape its namespace', () => {
  for (const bad of ['', '../..', 'a/b', '..', 'solo/../mp', 'SOLO']) {
    assert.equal(saveKey('acct', bad === 'solo' ? bad : 'mp', 'x.omwsave'), 'saves/acct/x.omwsave', bad);
  }
  assert.equal(saveKey('acct', 'solo', 'x.omwsave'), 'saves/acct/solo/x.omwsave');
});
