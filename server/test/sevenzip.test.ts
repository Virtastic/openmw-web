// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// .7z archives — half of what Nexus actually serves.
//
// These need the p7zip binary, which ships in the server image but is not on every developer's
// machine, so they skip rather than fail when it is absent. The safety assertions matter most:
// this format is read by a subprocess, so the guarantee that an unsafe path refuses the whole
// archive BEFORE anything is written has to be ours and has to be tested.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractSevenZip, listSevenZip, sniffArchive } from '../src/core/sevenzip';
import { findDataFolders } from '../src/core/mod-archive';

/** p7zip is in the server image; a dev box may not have it. */
const have7z = (() => {
  try { execFileSync('7z', ['i'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const skip = have7z ? undefined : { skip: 'p7zip not installed on this machine' };

/** Build a real .7z with the same binary the server reads it with. */
function make7z(files: { name: string; data: string }[]): string {
  const src = mkdtempSync(join(tmpdir(), '7zs-'));
  for (const f of files) {
    const full = join(src, f.name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, f.data);
  }
  const out = join(mkdtempSync(join(tmpdir(), '7zo-')), 'mod.7z');
  execFileSync('7z', ['a', '-t7z', '-bd', out, `${src}/.`], { stdio: 'ignore' });
  return out;
}

test('a .7z is recognised by its bytes, not its name', skip ?? {}, () => {
  const z = make7z([{ name: 'a.txt', data: 'x' }]);
  assert.equal(sniffArchive(z), '7z');
  // The mistake people actually make: renaming rather than converting.
  const lying = join(mkdtempSync(join(tmpdir(), '7zl-')), 'mod.zip');
  writeFileSync(lying, readFileSync(z));
  assert.equal(sniffArchive(lying), '7z', 'the extension must not be believed');
});

test('a real mod layout lists and unpacks', skip ?? {}, async () => {
  const z = make7z([
    { name: '00 Core/Better Bodies.esp', data: 'plugin' },
    { name: '00 Core/Meshes/x.nif', data: 'mesh' },
    { name: '01 Optional/Textures/t.dds', data: 'tex' },
    { name: 'readme.txt', data: 'notes' },
  ]);
  const entries = await listSevenZip(z);
  const paths = entries.filter((e) => !e.isDir).map((e) => e.path).sort();
  assert.deepEqual(paths, ['00 Core/Better Bodies.esp', '00 Core/Meshes/x.nif',
    '01 Optional/Textures/t.dds', 'readme.txt']);

  // And the SAME candidate detection the zip path uses works on it unchanged, which is the
  // whole reason listing returns the zip reader's shape.
  const cands = findDataFolders(entries.map((e) => ({ path: e.path, size: e.size, isDir: e.isDir })));
  assert.deepEqual(cands.map((c) => c.path).sort(), ['00 Core', '01 Optional']);

  const dest = mkdtempSync(join(tmpdir(), '7zx-'));
  await extractSevenZip(z, dest);
  assert.equal(readFileSync(join(dest, '00 Core', 'Meshes', 'x.nif'), 'utf8'), 'mesh');
});

test('sizes come through, so the chooser can say how big a variant is', skip ?? {}, async () => {
  const z = make7z([{ name: 'big.bsa', data: 'y'.repeat(5000) }]);
  const e = (await listSevenZip(z)).find((x) => x.path === 'big.bsa');
  assert.ok(e);
  assert.equal(e.size, 5000);
});

test('the archive itself is not listed as one of its own entries', skip ?? {}, async () => {
  // `7z l -slt` prints a header block whose Path is the archive. Counting that as a file would
  // put a phantom entry in every candidate's file count.
  const z = make7z([{ name: 'only.txt', data: 'x' }]);
  const entries = await listSevenZip(z);
  assert.ok(!entries.some((e) => e.path.endsWith('.7z')), 'the archive leaked into its listing');
});

test('an entry limit refuses rather than unpacking everything', skip ?? {}, async () => {
  const z = make7z([{ name: 'a.txt', data: 'x' }, { name: 'b.txt', data: 'x' }]);
  await assert.rejects(() => listSevenZip(z, 1), (e: Error) => /file limit/.test(e.message));
});

test('a file that is not an archive at all is named as such', () => {
  const p = join(mkdtempSync(join(tmpdir(), '7zn-')), 'x.zip');
  writeFileSync(p, Buffer.from('just some text, not an archive'));
  assert.equal(sniffArchive(p), 'unknown');
});

test('a RAR is identified so the message can say what to do', () => {
  const p = join(mkdtempSync(join(tmpdir(), '7zr-')), 'mod.7z');
  writeFileSync(p, Buffer.from('Rar!\x1a\x07\x00padding-to-eight'));
  assert.equal(sniffArchive(p), 'rar');
});
