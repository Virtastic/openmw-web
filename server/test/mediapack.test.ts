// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Media pack: loose voice/music/video files ride as ONE media.tar per account. The wizard
// builds the tar client-side; the server's verifyMediaPack streams it back and proves every
// entry against the vanilla manifest — a pack with anything foreign in it is deleted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Locker, MEDIA_PACK } from '../src/data/locker';
import { tmpDataDir } from './helpers';

// Minimal USTAR writer — the same format the wizard emits (and the verifier parses).
function tarOf(entries: { name: string; data: Buffer }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const hdr = Buffer.alloc(512);
    hdr.write(e.name, 0, 100, 'latin1');
    hdr.write('0000644\0', 100, 'latin1'); // mode
    hdr.write('0000000\0', 108, 'latin1'); // uid
    hdr.write('0000000\0', 116, 'latin1'); // gid
    hdr.write(e.data.length.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
    hdr.write('00000000000\0', 136, 'latin1'); // mtime
    hdr.write('        ', 148, 'latin1'); // checksum spaces while summing
    hdr.write('0', 156, 'latin1'); // typeflag: regular file
    hdr.write('ustar', 257, 'latin1');
    hdr.write('00', 263, 'latin1');
    let sum = 0;
    for (const b of hdr) sum += b;
    hdr.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
    blocks.push(hdr, e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive
  return Buffer.concat(blocks);
}

function fakeStorageServing(objects: Map<string, Buffer>) {
  return {
    async presignPut(key: string) { return `https://s.invalid/${key}?put`; },
    async presignGet(key: string) {
      const b = objects.get(key);
      if (!b) throw new Error('no object ' + key);
      return `data:application/octet-stream;base64,${b.toString('base64')}`;
    },
    async delete(key: string) { objects.delete(key); },
    async getHead(key: string, n: number) {
      const b = objects.get(key);
      if (!b) throw new Error('no object ' + key);
      return b.subarray(0, n);
    },
  };
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function boot(objects: Map<string, Buffer>, media: { name: string; data: Buffer }[]) {
  const locker = new Locker({ dataDir: tmpDataDir(), maxBytesPerAccount: 10_000_000, storage: fakeStorageServing(objects) });
  locker.configureAccepted({ files: [
    { name: 'Morrowind.esm', size: 100, sha256: 'a'.repeat(64) },
    ...media.map((m) => ({ name: m.name, size: m.data.length, sha256: sha(m.data) })),
  ] });
  return locker;
}

// Only Sound/** is packed; Music/Video/Splash/Fonts upload per-file like the ESM/BSA.
const VOICE = { name: 'Sound/Vo/a/f/hello.mp3', data: Buffer.from('ID3fakevoicedata') };
const VOICE2 = { name: 'Sound/Vo/i/m/greet.mp3', data: Buffer.from('ID3morevoicedata') };
const MUSIC = { name: 'Music/Explore/mx_explore_1.mp3', data: Buffer.from('ID3fakemusicdata') };

test('voice collapses to a pack row, other media to folder rows; ALL are required', () => {
  const locker = boot(new Map(), [VOICE, VOICE2, MUSIC]);
  const req = locker.requiredManifest();
  const pack = req.find((f) => f.name === MEDIA_PACK);
  assert.ok(pack, 'media.tar row present');
  assert.equal(pack!.media, true);
  assert.equal(pack!.size, VOICE.data.length + VOICE2.data.length, 'pack covers voice only');

  // Everything the manifest lists is content THIS SERVER loads, so nothing is optional:
  // a client missing an expansion or the media cannot match the world the server authors.
  assert.ok(req.every((f) => f.required), 'every row required');

  // Music is summarised as a folder row, not 6k individual files nobody can read.
  const music = req.find((f) => f.name === 'Music/');
  assert.ok(music, 'Music/ folder row present');
  assert.equal(music!.media, true);
  assert.equal(music!.size, MUSIC.data.length);
  assert.ok(!req.some((f) => /^Sound\//i.test(f.name)), 'no per-file voice rows');
  assert.ok(req.some((f) => f.name === 'Morrowind.esm'), 'plugins still listed by name');
});

test('a clean pack verifies and stays; a pack with a foreign file is deleted', async () => {
  const objects = new Map<string, Buffer>();
  const locker = boot(objects, [VOICE, VOICE2, MUSIC]);
  await locker.attest('alice', [], '127.0.0.1');

  // Clean pack.
  const good = tarOf([VOICE, VOICE2]);
  objects.set(`gamedata/alice/${MEDIA_PACK}`, good);
  const auth = await locker.authorizeUpload('alice', { name: MEDIA_PACK, size: good.length, sha256: sha(good) });
  assert.equal(auth.ok, true, 'plausible-size pack authorized');
  const rec = await locker.recordUploaded('alice', { name: MEDIA_PACK, size: good.length, sha256: sha(good) });
  assert.equal(rec.ok, true);
  await locker.verifyMediaPack('alice');
  assert.ok((await locker.filesOf('alice')).some((f) => f.name === MEDIA_PACK), 'clean pack survives verification');

  // Pack smuggling a foreign file: rejected wholesale.
  const evil = tarOf([VOICE, { name: 'Sound/Vo/warez.zip', data: Buffer.from('definitely not morrowind') }]);
  objects.set(`gamedata/alice/${MEDIA_PACK}`, evil);
  await locker.recordUploaded('alice', { name: MEDIA_PACK, size: evil.length, sha256: sha(evil) });
  await locker.verifyMediaPack('alice');
  assert.ok(!(await locker.filesOf('alice')).some((f) => f.name === MEDIA_PACK), 'foreign entry kills the pack');
  assert.ok(!objects.has(`gamedata/alice/${MEDIA_PACK}`), 'and the object is deleted');
});

test('an oversized pack is refused up front; not-a-tar is refused at confirm', async () => {
  const objects = new Map<string, Buffer>();
  const locker = boot(objects, [VOICE]);
  await locker.attest('bob', [], '127.0.0.1');
  const auth = await locker.authorizeUpload('bob', { name: MEDIA_PACK, size: 999_999_999, sha256: 'f'.repeat(64) });
  assert.equal(auth.ok, false, 'implausibly large pack refused');

  const junk = Buffer.from('this is not a tar file at all, padded '.repeat(20));
  objects.set(`gamedata/bob/${MEDIA_PACK}`, junk);
  const rec = await locker.recordUploaded('bob', { name: MEDIA_PACK, size: junk.length, sha256: sha(junk) });
  assert.equal(rec.ok, false, 'no ustar magic = refused');
  assert.ok(!objects.has(`gamedata/bob/${MEDIA_PACK}`), 'junk deleted');
});
