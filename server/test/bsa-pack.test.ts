// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The TES3 BSA writer, pinned to the layout wasm-build/build-assetpack.py produces.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readBsaNames, tes3Hash, writeBsa } from '../src/core/bsa-pack';

test('tes3Hash matches Bsa::getHash worked by hand', () => {
  // "ab": low = 'a'; high: temp='b', rotate right by ('b' & 31)=2 -> 0x80000018.
  assert.deepEqual(tes3Hash(Buffer.from('ab')), { lo: 0x61, hi: 0x80000018 });
  assert.deepEqual(tes3Hash(Buffer.from('cd')), { lo: 0x63, hi: 0x40000006 });
});

test('writeBsa produces the same bytes as build-assetpack.py, and reads back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsa-'));
  writeFileSync(join(dir, 'cd'), 'xyz');
  writeFileSync(join(dir, 'AB'), 'hi');
  const out = join(dir, 'out.bsa');
  // Given out of hash order and in upper case: the writer sorts and lowercases.
  await writeBsa(out, [
    { name: 'cd', path: join(dir, 'cd'), size: 3 },
    { name: 'AB', path: join(dir, 'AB'), size: 2 },
  ]);
  const expected = Buffer.from([
    0x00, 0x01, 0x00, 0x00, 0x1e, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, // version, hashOffset, count
    0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // ab: size 2, offset 0
    0x03, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, // cd: size 3, offset 2
    0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, // name offsets
    0x61, 0x62, 0x00, 0x63, 0x64, 0x00, // "ab\0cd\0"
    0x61, 0x00, 0x00, 0x00, 0x18, 0x00, 0x00, 0x80, // hash(ab)
    0x63, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x40, // hash(cd)
    0x68, 0x69, 0x78, 0x79, 0x7a, // "hi" "xyz"
  ]);
  const got = readFileSync(out);
  assert.deepEqual(got, expected);
  assert.deepEqual(readBsaNames(got), [{ name: 'ab', size: 2 }, { name: 'cd', size: 3 }]);
});

test('names are stored lowercase with backslashes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsa-'));
  writeFileSync(join(dir, 'x'), '1');
  const out = join(dir, 'out.bsa');
  await writeBsa(out, [{ name: 'Meshes/TR/Door.NIF', path: join(dir, 'x'), size: 1 }]);
  assert.deepEqual(readBsaNames(readFileSync(out)), [{ name: 'meshes\\tr\\door.nif', size: 1 }]);
});

// Backlog 176: Tamriel_Data HD passes the u32 data limit, and the writer hard-failed ("folder
// may be full"). The cap is injected so the split is proved with bytes, not gigabytes.
test('a data block over the cap is split greedily into <name>-N.bsa, each under it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsa-'));
  const files = ['a', 'b', 'c', 'd', 'e'].map((n) => {
    writeFileSync(join(dir, n), n.repeat(4));
    return { name: `meshes/${n}.nif`, path: join(dir, n), size: 4 };
  });
  const written = await writeBsa(join(dir, 'td.bsa'), files, 10); // 2 files per archive
  assert.deepEqual(written.map((p) => p.slice(dir.length + 1)), ['td-1.bsa', 'td-2.bsa', 'td-3.bsa']);
  const all = written.flatMap((p) => readBsaNames(readFileSync(p)));
  assert.equal(all.length, 5, 'every file lands in exactly one archive');
  assert.deepEqual(new Set(all.map((f) => f.name)), new Set(files.map((f) => f.name.replace('/', '\\'))));
  for (const p of written) {
    const bytes = readBsaNames(readFileSync(p)).reduce((n, f) => n + f.size, 0);
    assert.ok(bytes <= 10, `${p} carries ${bytes} bytes of data, over the cap`);
  }
  // Under the cap: one archive, the plain name — the shape mod-install.test.ts asserts.
  assert.deepEqual(await writeBsa(join(dir, 'one.bsa'), files, 100), [join(dir, 'one.bsa')]);
  // A single file over the cap cannot be split and says so.
  await assert.rejects(writeBsa(join(dir, 'x.bsa'), files.slice(0, 1), 3), /exceeds the u32 offset limit on its own/);
});
