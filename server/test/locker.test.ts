// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 3.5/3.55 storage locker. The assertions here are the LEGAL invariants, not just
// behaviour: per-account prefixes, no dedup, owner-only reads, attestation before bytes,
// and refusal of anything that is not one of the three ESMs by exact hash (CL2). Breaking one of these is what
// turns a backup locker into hosting (docs/LEGAL.md §2).

import test from 'node:test';
import assert from 'node:assert/strict';
import { lockerPublicBase } from '../src/data/fsstorage';
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

test('quota is enforced before a URL is minted', async () => {
  const storage = fakeStorage();
  const locker = new Locker({ dataDir: tmpDataDir(), maxBytesPerAccount: 50, storage });
  locker.configureAccepted(VANILLA);
  await locker.attest('alice', [FILE], 'ip');
  assert.deepEqual(await locker.authorizeUpload('alice', FILE), { ok: false, reason: 'quota' });
  assert.equal(storage.puts.length, 0);
});

test('downloads go only to files the account itself holds', async () => {
  const { locker } = mk();
  await locker.attest('alice', [FILE], 'ip');
  assert.equal(await locker.authorizeDownload('alice', 'Morrowind.esm'), undefined,
    'a file this account never confirmed is not theirs to fetch');
  assert.equal(await locker.authorizeDownload('bob', 'Morrowind.esm'), undefined);
});

test('erase removes the objects, the manifest and the attestation', async () => {
  const { locker, storage } = mk();
  await locker.attest('alice', [FILE], 'ip');
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

// THE ORIGIN A BROWSER REACHES THIS DEPLOYMENT ON, derived once from the wizard's domain
// answer. server.ts derived it; the gateway — a different program serving the same players —
// hardcoded loopback instead, so one answer produced working URLs in single player and URLs
// pointing at 127.0.0.1 in multiplayer. Nothing reports that: an upload succeeds and the
// download fails later, which is why the settings page deliberately does not ask again.
test('the public base comes from the domain, and both programs derive it the same way', async () => {
  assert.equal(lockerPublicBase('play.example.com', 8080), 'https://play.example.com');
  assert.equal(lockerPublicBase('', 8080), 'http://127.0.0.1:8080',
    'no domain answered: loopback is the only honest fallback');
  // An explicit [locker].publicBase still wins — a deployment behind an unusual proxy.
  assert.equal(lockerPublicBase('play.example.com', 8080, 'https://cdn.example.net'),
    'https://cdn.example.net', 'a hand-tuned publicBase must override the derived one');
  assert.equal(lockerPublicBase('play.example.com', 8080, ''), 'https://play.example.com',
    'an EMPTY explicit value is not a choice; it must fall through to the domain');

  // The regression is a program building its own instead of calling this. Anchored on tokens,
  // never on line endings — this checkout is CRLF and a newline-anchored scan silently
  // matches nothing and passes.
  const { readFileSync } = await import('node:fs');
  for (const f of ['src/server.ts', 'src/gateway/frontdoor.ts', 'src/gateway/main.ts']) {
    const src = readFileSync(f, 'utf8');
    assert.ok(src.includes('lockerPublicBase('), `${f} must derive the public base, not invent one`);
  }
  // And the front door must hand THAT to the storage, not a literal.
  const fd = readFileSync('src/gateway/frontdoor.ts', 'utf8');
  const call = fd.slice(fd.indexOf('lockerStorageFrom('));
  assert.ok(call.slice(0, 220).includes('lockerPublicBase('),
    'the multiplayer locker is built from a hardcoded origin again');

  // THE ANTI-PATTERN ITSELF. Checking that a file merely MENTIONS the helper is not enough:
  // it passed while server.ts still built the password-reset base as
  // `config.locker.publicBase || http://127.0.0.1:<port>` a few hundred lines further down —
  // and publicBase is only ever the config FILE's value, never the one derived from the
  // domain, so a server behind a domain mailed reset links pointing at loopback. The
  // precedence belongs inside lockerPublicBase; nothing should be spelling it out again.
  for (const f of ['src/server.ts', 'src/gateway/main.ts', 'src/gateway/frontdoor.ts']) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/publicBase\s*\|\|/.test(src),
      `${f} re-implements the publicBase fallback instead of using the helper`);
  }
});
