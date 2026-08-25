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

// A valid 32-byte TES3 plugin header, so getHead-based content sniffing passes for .esm.
function tes3Head(): Buffer {
  const b = Buffer.alloc(32);
  b.write('TES3', 0, 'latin1');
  b.write('HEDR', 16, 'latin1');
  b.writeFloatLE(1.2, 24);
  return b;
}

function fakeStorage() {
  const puts: string[] = [];
  const gets: string[] = [];
  const deletes: string[] = [];
  // What getHead returns for a key; default is a valid TES3 header so the happy path passes.
  const heads = new Map<string, Buffer>();
  return {
    puts, gets, deletes, heads,
    async presignPut(key: string) { puts.push(key); return `https://storage.invalid/${key}?put`; },
    async presignGet(key: string) { gets.push(key); return `https://storage.invalid/${key}?get`; },
    async delete(prefix: string) { deletes.push(prefix); },
    async getHead(key: string) { return heads.get(key) ?? tes3Head(); },
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

test('a different distribution of a known file is accepted by name+size, not exact hash', async () => {
  // Steam/GOG/disc copies of Morrowind.esm differ byte-for-byte; a friend's legit copy has
  // a hash we never saw. Same name, near-identical size -> accept. A movie renamed to
  // Morrowind.esm has a wildly wrong size -> still refused.
  const { locker } = mk();
  await locker.attest('bob', [FILE], 'ip');
  const gogCopy = { name: 'Morrowind.esm', size: 102, sha256: 'c'.repeat(64) }; // +2% size, unknown hash
  assert.equal((await locker.authorizeUpload('bob', gogCopy)).ok, true, 'legit other distribution passes');

  const warez = { name: 'Morrowind.esm', size: 900000, sha256: 'd'.repeat(64) }; // right name, absurd size
  assert.deepEqual(await locker.authorizeUpload('bob', warez), { ok: false, reason: 'not-recognized' });
});

test('acceptByNameAndSize:false keeps the strict hash-only gate', async () => {
  const storage = fakeStorage();
  const locker = new Locker({ dataDir: tmpDataDir(), maxBytesPerAccount: 1000, storage });
  locker.configureAccepted(VANILLA, [], { acceptByNameAndSize: false });
  await locker.attest('carol', [FILE], 'ip');
  const otherDist = { name: 'Morrowind.esm', size: 101, sha256: 'c'.repeat(64) };
  assert.deepEqual(await locker.authorizeUpload('carol', otherDist), { ok: false, reason: 'not-recognized' });
});

test('confirm-upload sniffs the actual bytes: arbitrary content wearing a game name is deleted', async () => {
  const { locker, storage } = mk();
  await locker.attest('mallory', [FILE], 'ip');
  // Passed name+size (it is 100 bytes named Morrowind.esm), but what landed is not a TES3
  // file — getHead returns junk. recordUploaded must refuse it and delete the object.
  storage.heads.set('gamedata/mallory/Morrowind.esm', Buffer.from('not a real esm at all!!!!!!!!!!!!'));
  const bad = await locker.recordUploaded('mallory', FILE);
  assert.deepEqual(bad, { ok: false, reason: 'not-recognized' });
  assert.ok(storage.deletes.includes('gamedata/mallory/Morrowind.esm'), 'refused bytes are deleted');
  assert.deepEqual(await locker.filesOf('mallory'), [], 'nothing recorded');

  // A real TES3 header (the fakeStorage default) is accepted and recorded.
  storage.heads.delete('gamedata/mallory/Morrowind.esm');
  const good = await locker.recordUploaded('mallory', FILE);
  assert.deepEqual(good, { ok: true });
  assert.equal((await locker.filesOf('mallory')).length, 1);
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

test('the expansions are flagged soloOptional; the base game and the media never are', () => {
  const { locker } = mk();
  locker.configureAccepted({ files: [
    { name: 'Morrowind.esm', size: 100, sha256: 'a'.repeat(64) },
    { name: 'Morrowind.bsa', size: 900, sha256: 'b'.repeat(64) },
    { name: 'Tribunal.esm', size: 50, sha256: 'c'.repeat(64) },
    { name: 'Tribunal.bsa', size: 500, sha256: 'd'.repeat(64) },
    { name: 'Bloodmoon.esm', size: 60, sha256: 'e'.repeat(64) },
    { name: 'Bloodmoon.bsa', size: 600, sha256: 'f'.repeat(64) },
    { name: 'BetterBodies.esp', size: 10, sha256: '1'.repeat(64) },
    { name: 'Music/Explore/mx_1.mp3', size: 30, sha256: '2'.repeat(64) },
    { name: 'Sound/Vo/a/f/hello.mp3', size: 20, sha256: '3'.repeat(64) },
  ] });
  const rows = locker.requiredManifest();
  const by = (n: string) => rows.find((r) => r.name === n);

  // STILL REQUIRED, all of it. Multiplayer pins the world's content list and refuses a client
  // whose own list differs (core/manifest.ts ContentGate), so relaxing `required` would not
  // let anyone in — it would only move the refusal to after a multi-gigabyte upload.
  assert.ok(rows.every((r) => r.required), 'nothing is downgraded to optional outright');

  // The flag says WHO it is required for. Only the expansions, and both halves of each pair:
  // an .esm without its .bsa renders marker_error for everything it owns (core/gamedata.ts),
  // so offering to skip one without the other would produce a broken game, not a smaller one.
  assert.deepEqual(
    rows.filter((r) => r.soloOptional).map((r) => r.name).sort(),
    ['Bloodmoon.bsa', 'Bloodmoon.esm', 'Tribunal.bsa', 'Tribunal.esm'],
  );

  // The base game is never skippable — there is no game without it.
  assert.equal(by('Morrowind.esm')!.soloOptional, undefined);
  assert.equal(by('Morrowind.bsa')!.soloOptional, undefined);
  // Nor is a mod the world loads: a plugin changes the simulation, which is a different kind
  // of thing from content Bethesda sold separately.
  assert.equal(by('BetterBodies.esp')!.soloOptional, undefined);
  // Nor the media: without it dialogue auto-skips and the intro never plays.
  assert.equal(by('Music/')!.soloOptional, undefined);
  assert.equal(by('media.tar')!.soloOptional, undefined);
});
