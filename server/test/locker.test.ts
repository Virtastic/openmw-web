// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 3.5/3.55 storage locker. The assertions here are the LEGAL invariants, not just
// behaviour: per-account prefixes, no dedup, owner-only reads, attestation before bytes,
// and refusal of anything that is not a file we recognize. Breaking one of these is what
// turns a backup locker into hosting (docs/LEGAL.md §2).

import test from 'node:test';
import assert from 'node:assert/strict';
import { Locker } from '../src/data/locker';
import { tmpDataDir } from './helpers';

const VANILLA = {
  files: [
    { name: 'Morrowind.esm', size: 100, sha256: 'a'.repeat(64) },
    { name: 'Tribunal.esm', size: 50, sha256: 'b'.repeat(64) },
  ],
};

function fakeStorage() {
  const puts: string[] = [];
  const gets: string[] = [];
  const deletes: string[] = [];
  return {
    puts, gets, deletes,
    async presignPut(key: string) { puts.push(key); return `https://storage.invalid/${key}?put`; },
    async presignGet(key: string) { gets.push(key); return `https://storage.invalid/${key}?get`; },
    async delete(prefix: string) { deletes.push(prefix); },
  };
}

function mk() {
  const storage = fakeStorage();
  const locker = new Locker({ dataDir: tmpDataDir(), maxBytesPerAccount: 1000, storage });
  locker.configureAccepted(VANILLA);
  return { locker, storage };
}

const FILE = { name: 'Morrowind.esm', size: 100, sha256: 'a'.repeat(64) };

test('no bytes are accepted before an attestation is recorded', async () => {
  const { locker, storage } = mk();
  const refused = await locker.authorizeUpload('alice', FILE);
  assert.deepEqual(refused, { ok: false, reason: 'no-attestation' });
  assert.equal(storage.puts.length, 0, 'not even a presigned URL is minted');

  const att = await locker.attest('alice', [FILE], '203.0.113.1');
  assert.equal(att.statement, Locker.statement, 'the exact words shown are what is stored');
  assert.match(att.manifestHash, /^[0-9a-f]{64}$/);

  const ok = await locker.authorizeUpload('alice', FILE);
  assert.equal(ok.ok, true);
});

test('only recognized game files are accepted — this is not general file hosting', async () => {
  const { locker } = mk();
  await locker.attest('alice', [FILE], 'ip');
  const junk = { name: 'holiday-photos.zip', size: 10, sha256: 'f'.repeat(64) };
  assert.deepEqual(await locker.authorizeUpload('alice', junk), { ok: false, reason: 'not-recognized' });
});

test('keys are per-account and never deduplicated across accounts', async () => {
  const { locker, storage } = mk();
  await locker.attest('alice', [FILE], 'ip');
  await locker.attest('bob', [FILE], 'ip');
  const a = await locker.authorizeUpload('alice', FILE);
  const b = await locker.authorizeUpload('bob', FILE);
  assert.equal(a.ok && a.key, 'gamedata/alice/Morrowind.esm');
  assert.equal(b.ok && b.key, 'gamedata/bob/Morrowind.esm');
  assert.notEqual(a.ok && a.key, b.ok && b.key,
    'identical bytes MUST still be stored twice — dedup would make this our master copy');
  assert.equal(storage.puts.length, 2);
});

test('reads are owner-only and there is no path to another account’s files', async () => {
  const { locker } = mk();
  await locker.attest('alice', [FILE], 'ip');
  await locker.recordUploaded('alice', FILE);
  assert.ok(await locker.authorizeDownload('alice', 'Morrowind.esm'));
  assert.equal(await locker.authorizeDownload('bob', 'Morrowind.esm'), undefined,
    'another account must not be able to name their way into this library');
  assert.equal(await locker.authorizeDownload('alice', 'Tribunal.esm'), undefined,
    'a file this account never uploaded is not theirs to fetch');
});

test('quota is enforced against what the account already stores', async () => {
  const { locker } = mk();
  await locker.attest('alice', [FILE], 'ip');
  for (const f of [FILE, { ...FILE, name: 'Tribunal.esm', sha256: 'b'.repeat(64), size: 800 }]) {
    const r = await locker.authorizeUpload('alice', f);
    assert.equal(r.ok, true);
    await locker.recordUploaded('alice', f);
  }
  const over = await locker.authorizeUpload('alice', { name: 'Bloodmoon.esm', size: 500, sha256: 'a'.repeat(64) });
  assert.deepEqual(over, { ok: false, reason: 'quota' });
});

test('a client cannot claim a file that differs from the copy we stored', async () => {
  const { locker } = mk();
  await locker.attest('alice', [FILE], 'ip');
  await locker.recordUploaded('alice', FILE);

  assert.equal(await locker.verifyAgainstLocker('alice', [{ name: 'Morrowind.esm', sha256: 'a'.repeat(64) }]), null);
  const tampered = await locker.verifyAgainstLocker('alice', [{ name: 'Morrowind.esm', sha256: 'c'.repeat(64) }]);
  assert.match(String(tampered), /does not match/);
  // A non-locker user is unaffected: the ordinary content gate governs them.
  assert.equal(await locker.verifyAgainstLocker('nobody', [{ name: 'Morrowind.esm', sha256: 'c'.repeat(64) }]), null);
});

test('erase removes the objects, the manifest and the attestation', async () => {
  const { locker, storage } = mk();
  await locker.attest('alice', [FILE], 'ip');
  await locker.recordUploaded('alice', FILE);
  await locker.erase('alice');
  assert.deepEqual(storage.deletes, ['gamedata/alice/']);
  assert.deepEqual(await locker.filesOf('alice'), []);
  assert.equal(await locker.attestationOf('alice'), undefined);
});

test('with no storage configured the locker is inert (the client keeps using its own disk)', async () => {
  const locker = new Locker({ dataDir: tmpDataDir(), maxBytesPerAccount: 1000 });
  locker.configureAccepted(VANILLA);
  assert.equal(locker.enabled, false);
  await locker.attest('alice', [FILE], 'ip');
  assert.deepEqual(await locker.authorizeUpload('alice', FILE), { ok: false, reason: 'not-recognized' });
});
