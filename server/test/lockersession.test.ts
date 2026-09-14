// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// A DEPLOY MUST NOT SIGN EVERYONE OUT. Locker sessions are how a signed-in player reaches the
// locker and their saves, and they advertise a 24 h life -- but the store was a bare in-memory
// Map, so every restart silently invalidated every one of them mid-session. The player does not
// see "signed out": the cloud/demo boot dead-ends at "No locker session. Please sign in again."
// on a black screen, which is exactly what was reported on morrowind.virtastic.app after a
// redeploy. Persisted in the shared dir, a restart is invisible to whoever is playing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LockerSessionStore } from '../src/auth/identities';
import { tmpDataDir } from './helpers';

test('a locker session survives a restart, and expiry/revocation still hold', async () => {
  const dir = tmpDataDir();
  const before = new LockerSessionStore(24 * 60 * 60 * 1000, dir);
  const token = before.mint('alice');
  assert.equal(before.resolve(token), 'alice');

  // The deploy: a brand-new process over the same shared dir.
  const after = new LockerSessionStore(24 * 60 * 60 * 1000, dir);
  assert.equal(after.resolve(token), 'alice', 'the signed-in player was thrown out by a restart');

  // A revocation must outlive a restart too, or the row would sign them back in.
  after.revokeAccount('alice');
  assert.equal(after.resolve(token), undefined);
  assert.equal(new LockerSessionStore(24 * 60 * 60 * 1000, dir).resolve(token), undefined,
    'a revoked session came back after a restart');

  // An EXPIRED row must not resurrect a session either.
  const shortLived = new LockerSessionStore(1, dir);
  const stale = shortLived.mint('bob');
  // Let the 1 ms TTL actually elapse: mint and resolve inside the same millisecond is not
  // expired yet, and the deploy's test gate lost that race where a laptop never did.
  await new Promise((r) => setTimeout(r, 5));
  const later = new LockerSessionStore(1, dir);
  assert.equal(later.resolve(stale), undefined, 'an expired session resolved after a restart');

  // No shared dir = the old behaviour, memory only: nothing to persist, nothing to leak.
  const memOnly = new LockerSessionStore();
  const t2 = memOnly.mint('cara');
  assert.equal(memOnly.resolve(t2), 'cara');
  assert.equal(new LockerSessionStore().resolve(t2), undefined);
});
