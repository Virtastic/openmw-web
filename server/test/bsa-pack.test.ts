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
