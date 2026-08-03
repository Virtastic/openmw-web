// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase C store. These target the rules whose failure modes are SILENT — a friendship that
// half-exists, a block that only works one way, a request that outlives its TTL — rather
// than the happy path, which any smoke test would catch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { SocialStore } from '../src/core/socialstore';

const T0 = 1_700_000_000_000;

test('social store: friendship is symmetric and stored once, whichever order it is added', () => {
  const s = new SocialStore(':memory:');
  s.addFriend('bob', 'alice', T0); // deliberately not alphabetical
  assert.ok(s.areFriends('alice', 'bob'));
  assert.ok(s.areFriends('bob', 'alice'), 'friendship must read the same from both sides');
  assert.deepEqual(s.friendsOf('alice').map((f) => f.account), ['bob']);
  assert.deepEqual(s.friendsOf('bob').map((f) => f.account), ['alice']);

  // Adding again in the other order must not create a second row — two rows for one pair
  // is how the two directions get to disagree later.
  s.addFriend('alice', 'bob', T0 + 5);
  assert.equal(s.friendsOf('alice').length, 1, 'duplicate pair inserted');

  s.removeFriend('bob', 'alice');
  assert.equal(s.areFriends('alice', 'bob'), false);
  assert.equal(s.friendsOf('bob').length, 0, 'removal must clear it from both sides');
  s.close();
});

test('social store: self-friendship is refused rather than corrupting the pair invariant', () => {
  const s = new SocialStore(':memory:');
  s.addFriend('alice', 'alice', T0); // would violate CHECK(a < b) if it reached SQL
  assert.equal(s.friendsOf('alice').length, 0);
  s.close();
});

test('social store: a block applies in BOTH directions', () => {
  const s = new SocialStore(':memory:');
  s.addBlock('alice', 'mallory', T0);
  // The direction that matters and is easy to miss: mallory must not be able to reach
  // alice EITHER. A one-way check leaves the blocked party still able to invite.
  assert.ok(s.blockedEitherWay('alice', 'mallory'));
  assert.ok(s.blockedEitherWay('mallory', 'alice'));
  assert.equal(s.blockedEitherWay('alice', 'bob'), false);

  // Only the blocker can undo it: mallory removing "their" block is a no-op, because the
  // row is keyed (blocker, blocked) and mallory blocked nobody.
  s.removeBlock('mallory', 'alice');
  assert.ok(s.blockedEitherWay('alice', 'mallory'), 'the blocked party must not clear the block');
  s.removeBlock('alice', 'mallory');
  assert.equal(s.blockedEitherWay('alice', 'mallory'), false);
  s.close();
});

test('social store: requests expire on read, not only when the sweep runs', () => {
  const s = new SocialStore(':memory:');
  s.addRequest('alice', 'bob', T0, 1000);
  assert.ok(s.hasRequest('alice', 'bob', T0 + 999));
  // Past the TTL it must be unacceptable IMMEDIATELY. If expiry only happened in the
  // sweep, a request would stay acceptable for however long the sweep interval is.
  assert.equal(s.hasRequest('alice', 'bob', T0 + 1001), false, 'expired request still acceptable');
  assert.deepEqual(s.pendingFor('bob', T0 + 1001), [], 'expired request still listed');
  assert.equal(s.outstandingFrom('alice', T0 + 1001), 0, 'expired request still counted against the cap');

  assert.equal(s.sweepExpired(T0 + 1001), 1);
  assert.equal(s.sweepExpired(T0 + 1001), 0, 'sweep must be idempotent');
  s.close();
});

test('social store: re-sending a request refreshes it rather than stacking duplicates', () => {
  const s = new SocialStore(':memory:');
  s.addRequest('alice', 'bob', T0, 1000);
  s.addRequest('alice', 'bob', T0 + 500, 1000);
  assert.equal(s.outstandingFrom('alice', T0 + 600), 1, 'duplicate requests must collapse');
  // The refreshed TTL is the later one.
  assert.ok(s.hasRequest('alice', 'bob', T0 + 1400));
  s.close();
});

test('social store: the graph survives a reopen', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'omw-social-'));
  try {
    const a = new SocialStore(dir);
    a.addFriend('alice', 'bob', T0);
    a.addBlock('alice', 'mallory', T0);
    a.close();

    // The entire reason for using a database rather than memory: a restart must not
    // silently unfriend everyone.
    const b = new SocialStore(dir);
    assert.ok(b.areFriends('alice', 'bob'), 'friendship did not survive a restart');
    assert.ok(b.blockedEitherWay('alice', 'mallory'), 'block did not survive a restart');
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
