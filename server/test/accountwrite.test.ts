// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// EVERY ACCOUNT MUTATION MUST BE WRITTEN THROUGH, NOT QUEUED.
//
// flush() writes `this.cache.get(key)` while get() replaces the cached object on every clean
// read-through — so a field set on a caller-held Account and merely marked dirty could be
// written from a DIFFERENT object and silently lost. That is how finished characters went
// missing. Five mutations were still on that path afterwards; setUsername was the worst,
// because the usernames row is committed in its own transaction first: losing the doc write
// leaves the handle claimed and reserved for 30 days with no account admitting to it, so the
// player reads as un-onboarded and nobody can ever claim that name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore } from '../src/core/accounts';
import { deleteAccount } from '../src/persist/erase';
import { tmpDataDir } from './helpers';

async function newAccount(store: AccountStore, name: string) {
  const a = await store.createSso(name);
  assert.ok(typeof a !== 'string', `could not create ${name}: ${String(a)}`);
  return a;
}

// mutate() re-reads the doc from disk and Object.assigns it over the caller's object, then
// clears the dirty flag. Object.assign does not remove keys the disk copy lacks, so a NEW
// field queued in memory survives — but a field that already exists on disk with an older
// value is rolled straight back, and the flag that would have written the new one is dropped.
// rank and banned are exactly that shape.
test('a rank change is not rolled back by the next character mutation', async () => {
  const dir = tmpDataDir();
  const store = new AccountStore(dir);
  const acct = await newAccount(store, 'someone');
  store.setRank('someone', 0);
  await store.flush(); // rank now exists on disk

  store.setRank('someone', 3); // promote to moderator
  store.createCharacter(acct, 'Someone'); // any mutate(): re-reads disk, clears dirty
  await store.flush();

  const fresh = new AccountStore(dir);
  assert.equal((await fresh.get('someone'))?.rank, 3, 'the promotion was silently rolled back');
});

test('an unban is not rolled back by the next character mutation', async () => {
  const dir = tmpDataDir();
  const store = new AccountStore(dir);
  const acct = await newAccount(store, 'someone');
  store.setBanned('someone', true);
  await store.flush();

  store.setBanned('someone', false);
  store.createCharacter(acct, 'Someone');
  await store.flush();

  const fresh = new AccountStore(dir);
  assert.notEqual((await fresh.get('someone'))?.banned, true,
    'the account is still banned after being unbanned');
});

test('the claimed handle and the account doc agree', async () => {
  const dir = tmpDataDir();
  const store = new AccountStore(dir);
  const acct = await newAccount(store, 'someone');
  assert.equal(await store.setUsername(acct, 'Kestrel'), 'ok');

  // Nobody else may take it...
  const other = await newAccount(store, 'rival');
  assert.equal(await store.setUsername(other, 'Kestrel'), 'taken');
  // ...and the owner is on record as having it, so it is not stranded.
  assert.equal((await store.get('someone'))?.username, 'Kestrel');
});

test('email and ban are written through too', async () => {
  const dir = tmpDataDir();
  const store = new AccountStore(dir);
  const acct = await newAccount(store, 'someone');

  store.setEmail(acct, 'player@example.com', false);
  store.setBanned('someone', true);
  await store.get('someone'); // the cache-swapping read again
  await store.flush();

  const fresh = new AccountStore(dir);
  const back = await fresh.get('someone');
  assert.equal(back?.email, 'player@example.com');
  assert.equal(back?.banned, true, 'a banned player would still be playing');
});

// THE STALE-FLUSH ROLLBACK. The gateway and every world hold their own AccountStore over one
// accounts.db. touchLastSeen queued a key, and flush() then wrote this process's WHOLE cached
// doc back — merging only the character list — so a world holding the copy it read at join
// reverted whatever another process had written since: a rank, a ban, a dashboard role, a
// password. And an account the admin erased came straight back on the next flush.
test('a stale flush does not revert fields another process wrote', async () => {
  const dir = tmpDataDir();
  const world = new AccountStore(dir);
  const gateway = new AccountStore(dir);
  await newAccount(world, 'someone');
  await world.get('someone');
  world.touchLastSeen('someone'); // a player left this world: its copy is now queued

  await gateway.get('someone');
  gateway.setRank('someone', 3);
  gateway.setBanned('someone', true);
  assert.equal(await gateway.setDashboardRole('someone', 'moderator'), true);

  await world.flush(); // the world writes back its unrelated lastSeenAt

  const back = await new AccountStore(dir).get('someone');
  assert.equal(back?.rank, 3, 'the promotion was reverted by a stale flush');
  assert.equal(back?.banned, true, 'the ban was reverted by a stale flush');
  assert.equal(back?.dashboardRole, 'moderator', 'the dashboard role was reverted by a stale flush');
});

test('a queued lastSeenAt does not hide a ban from the next login', async () => {
  const dir = tmpDataDir();
  const world = new AccountStore(dir);
  const gateway = new AccountStore(dir);
  await newAccount(world, 'someone');
  await world.get('someone');
  world.touchLastSeen('someone');

  await gateway.get('someone');
  gateway.setBanned('someone', true);

  assert.equal((await world.get('someone'))?.banned, true, 'the world served its pinned pre-ban copy');
});

test('a stale flush does not resurrect an erased account', async () => {
  const dir = tmpDataDir();
  const world = new AccountStore(dir);
  await newAccount(world, 'someone');
  world.touchLastSeen('someone');

  assert.equal((await deleteAccount(dir, 'someone')).account, true);
  await world.flush();

  assert.equal(await new AccountStore(dir).get('someone'), undefined, 'the erased account came back');
});

// A FIELD REMOVED ELSEWHERE STAYS REMOVED. mutate() folded the disk doc over the caller's object
// with Object.assign, which never deletes: a dashboard role revoked (or a 2FA secret reset) in the
// gateway while a world still held the account came back the next time that world wrote it.
test('a field another process removed is not written back by a held account', async () => {
  const dir = tmpDataDir();
  const world = new AccountStore(dir);
  const gateway = new AccountStore(dir);
  await newAccount(world, 'someone');
  assert.equal(await gateway.setDashboardRole('someone', 'moderator'), true);
  assert.equal(await gateway.setTotpSecret('someone', 'SECRET'), true);
  const held = await world.get('someone'); // the world's connection holds this object
  assert.equal(held?.dashboardRole, 'moderator');

  assert.equal(await gateway.setDashboardRole('someone', undefined), true);
  assert.equal(await gateway.setTotpSecret('someone', undefined), true);
  world.createCharacter(held!, 'Someone'); // any write-through from the world

  const back = await new AccountStore(dir).get('someone');
  assert.equal(back?.dashboardRole, undefined, 'the revoked dashboard role came back');
  assert.equal(back?.totpSecret, undefined, 'the reset 2FA secret came back');
  assert.equal(back?.characters?.length, 1, 'the write itself still landed');
});
