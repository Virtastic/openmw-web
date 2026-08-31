// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The zip reader, and mostly the things it must REFUSE.
//
// This parser exists to open files a stranger uploaded, so the interesting cases are all hostile:
// an entry that escapes the folder, one that expands to fill the disk, an encrypted archive with
// no password to give it, and a .rar someone renamed. Each has to fail with a message that names
// the problem, because the operator is the one who has to fix it.
//
// The fixtures are built here rather than committed, so what is under test is visible in the test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { crc32, extractEntry, listEntries, normaliseEntryPath, readEntry, ZipError } from '../src/core/zip';

/** Build a real zip. `store: true` writes the entry uncompressed (method 0). */
function makeZip(
  files: { name: string; data: Buffer | string; store?: boolean; flags?: number }[],
): string {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const body = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const isDir = f.name.endsWith('/');
    const comp = isDir ? Buffer.alloc(0) : f.store ? body : deflateRawSync(body);
    const method = isDir || f.store ? 0 : 8;
    const name = Buffer.from(f.name, 'utf8');
    const crc = isDir ? 0 : crc32(body);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(f.flags ?? 0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(isDir ? 0 : body.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(f.flags ?? 0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(isDir ? 0 : body.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += lh.length + name.length + comp.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);

  const path = join(mkdtempSync(join(tmpdir(), 'zip-')), 'a.zip');
  writeFileSync(path, Buffer.concat([...locals, cd, eocd]));
  return path;
}

// --- the happy path --------------------------------------------------------------------------

test('reads a deflated archive back byte for byte', () => {
  const body = Buffer.from('Meshes and textures and a plugin'.repeat(50));
  const z = makeZip([{ name: '00 Core/Meshes/x.nif', data: body }]);
  const [e] = listEntries(z);
  assert.equal(e!.path, '00 Core/Meshes/x.nif');
  assert.equal(e!.size, body.length);
  assert.equal(e!.method, 8);
  assert.deepEqual(readEntry(z, e!), body);
});

test('reads a stored entry too', () => {
  const z = makeZip([{ name: 'a.esp', data: 'plugin bytes', store: true }]);
  const [e] = listEntries(z);
  assert.equal(e!.method, 0);
  assert.equal(readEntry(z, e!).toString(), 'plugin bytes');
});

test('directories are listed and read as empty', () => {
  const z = makeZip([{ name: 'Textures/', data: '' }, { name: 'Textures/a.dds', data: 'x' }]);
  const es = listEntries(z);
  assert.equal(es.length, 2);
  assert.equal(es.find((e) => e.path === 'Textures')!.isDir, true);
  assert.equal(readEntry(z, es[0]!).length, 0);
});

test('backslash paths from Windows-built archives are normalised', () => {
  const z = makeZip([{ name: '00 Core\\Meshes\\x.nif', data: 'x' }]);
  assert.equal(listEntries(z)[0]!.path, '00 Core/Meshes/x.nif');
});

// --- refusals --------------------------------------------------------------------------------

test('an entry that escapes the folder kills the WHOLE archive', () => {
  // Not skipped. A mod that ships a traversal is not a mod with one bad file in it, and a
  // partial install of something hostile is worse than no install.
  const z = makeZip([{ name: 'ok.esp', data: 'x' }, { name: '../../etc/passwd', data: 'x' }]);
  assert.throws(() => listEntries(z), (e: Error) => e instanceof ZipError && /unsafe path/.test(e.message));
});

test('absolute and drive-letter paths are refused', () => {
  for (const bad of ['/etc/passwd', 'C:/Windows/x.dll', '\\\\server\\share\\x']) {
    assert.equal(normaliseEntryPath(bad), null, bad);
  }
});

test('a .rar renamed to .zip says so, instead of "corrupt"', () => {
  // The likeliest thing an operator actually does wrong, so the message has to name the fix.
  const path = join(mkdtempSync(join(tmpdir(), 'zip-')), 'mod.zip');
  writeFileSync(path, Buffer.from('Rar!\x1a\x07\x00' + 'x'.repeat(400)));
  assert.throws(() => listEntries(path), (e: Error) => /\.rar or \.7z/.test(e.message));
});

test('a password-protected archive is refused', () => {
  const z = makeZip([{ name: 'a.esp', data: 'x', flags: 0x1 }]);
  assert.throws(() => listEntries(z), (e: Error) => /password-protected/.test(e.message));
});

test('too many entries is refused before anything is read', () => {
  const z = makeZip([{ name: 'a.esp', data: 'x' }, { name: 'b.esp', data: 'x' }]);
  assert.throws(() => listEntries(z, { maxEntries: 1, maxEntryBytes: 1e9, maxTotalBytes: 1e9, maxRatio: 200 }),
    (e: Error) => /more than the 1 limit/.test(e.message));
});

test('a decompression bomb is refused on its ratio', () => {
  // 20 MB of zeroes deflates to almost nothing, which is exactly the shape of the attack.
  const z = makeZip([{ name: 'big.bsa', data: Buffer.alloc(20 * 1024 * 1024) }]);
  const [e] = listEntries(z);
  assert.throws(() => readEntry(z, e!), (err: Error) => /decompression bomb/.test(err.message));
});

test('a corrupted entry fails its checksum rather than being written out', () => {
  const z = makeZip([{ name: 'a.esp', data: 'the real bytes', store: true }]);
  const [e] = listEntries(z);
  // Same length, wrong content: only the CRC can catch this.
  assert.throws(() => readEntry(z, { ...e!, crc32: e!.crc32 ^ 0xffff }),
    (err: Error) => /failed its checksum/.test(err.message));
});

test('a truncated archive is refused', () => {
  const z = makeZip([{ name: 'a.esp', data: 'x'.repeat(1000) }]);
  const [e] = listEntries(z);
  assert.throws(() => readEntry(z, { ...e!, compressedSize: e!.compressedSize + 5000 }),
    (err: Error) => /truncated/.test(err.message));
});

test('an unsupported compression method is named, not guessed at', () => {
  const z = makeZip([{ name: 'a.esp', data: 'x' }]);
  const [e] = listEntries(z);
  assert.throws(() => readEntry(z, { ...e!, method: 14 }),
    (err: Error) => /unsupported compression method \(14\)/.test(err.message));
});

test('crc32 matches the known vector', () => {
  // Guards the table generator: a wrong table would make every checksum agree with itself and
  // catch nothing.
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

// --- extraction streams, it does not buffer -----------------------------------------------------
//
// readEntry() returns a Buffer, which is right for a plugin and wrong for an archive: Tamriel
// Rebuilt's TR_Data.bsa is over a gigabyte, and holding it compressed AND inflated and then
// handing the whole thing to writeFileSync is three copies of a file that never needed one.
// This module's header claims it never loads the archive into memory; that was true of the
// listing and, until extractEntry existed, false of the extraction.

test('a large entry extracts without ever being held whole in memory', async () => {
  // 64 MB of varied bytes: incompressible enough that a buffering implementation has to hold
  // it, and large enough that the difference is measurable.
  const big = Buffer.alloc(64 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE(i, i);
  const z = makeZip([{ name: 'TR_Data.bsa', data: big, store: true }]);
  const [e] = listEntries(z);

  const dest = join(mkdtempSync(join(tmpdir(), 'zx-')), 'out.bsa');
  const before = process.memoryUsage().heapUsed;
  await extractEntry(z, e!, dest);
  const grew = process.memoryUsage().heapUsed - before;

  assert.equal(statSync(dest).size, big.length, 'the file must arrive whole');
  assert.ok(grew < 32 * 1024 * 1024,
    `extraction grew the heap by ${Math.round(grew / 1048576)}MB for a 64MB file — it is buffering`);
});

test('extraction still catches a bad checksum', async () => {
  // The CRC is folded in as the bytes go past, so streaming must not have cost the check.
  const z = makeZip([{ name: 'a.esp', data: 'the real bytes', store: true }]);
  const [e] = listEntries(z);
  const dest = join(mkdtempSync(join(tmpdir(), 'zx-')), 'a.esp');
  await assert.rejects(() => extractEntry(z, { ...e!, crc32: e!.crc32 ^ 0xffff }, dest),
    (err: Error) => /failed its checksum/.test(err.message));
});

test('extraction refuses an entry that is bigger than it declared', async () => {
  // Enforced WHILE writing rather than after, so a lying header cannot fill the disk first.
  const z = makeZip([{ name: 'a.esp', data: 'x'.repeat(5000), store: true }]);
  const [e] = listEntries(z);
  const dest = join(mkdtempSync(join(tmpdir(), 'zx-')), 'a.esp');
  await assert.rejects(() => extractEntry(z, { ...e!, size: 10 }, dest),
    (err: Error) => /larger than it declared/.test(err.message));
});

test('a stored and a deflated entry both round-trip through extraction', async () => {
  const body = Buffer.from('meshes and textures'.repeat(500));
  for (const store of [true, false]) {
    const z = makeZip([{ name: 'x.nif', data: body, store }]);
    const [e] = listEntries(z);
    const dest = join(mkdtempSync(join(tmpdir(), 'zx-')), 'x.nif');
    await extractEntry(z, e!, dest);
    assert.deepEqual(readFileSync(dest), body, store ? 'stored' : 'deflated');
  }
});
