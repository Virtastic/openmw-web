// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Pack loose asset files into one TES3 BSA (version 0x100, uncompressed).
//
// A port of wasm-build/build-assetpack.py, which exists because ~3,300 loose meshes already
// thrashed the browser's StreamFS (one HTTP round trip and one LRU slot per file). Tamriel Data
// ships ~54,000 loose files. The gateway image is node:22-alpine with no python, so the writer
// lives here too; test/bsa-pack.test.ts pins the output byte-for-byte to the python one.
//
// FORMAT, mirroring components/bsa/bsafile.cpp readHeader():
//   u32 version(0x100), u32 hashOffset, u32 fileCount
//   fileCount x (u32 size, u32 offset)     offset relative to the data block start
//   fileCount x u32 nameOffset             into the name block
//   name block                             null-terminated, lowercase, backslash-separated
//   fileCount x (u32 hashLow, u32 hashHigh)
//   data
// hashOffset == 12*count + nameBlock.length; records sorted by (hashLow, hashHigh).

import { open, readFile } from 'node:fs/promises';

/** Port of Bsa::getHash (components/bsa/bsafile.cpp), on the stored (latin1) name bytes. */
export function tes3Hash(name: Buffer): { lo: number; hi: number } {
  const half = name.length >> 1;
  let acc = 0;
  let off = 0;
  for (let i = 0; i < half; i++) {
    acc = (acc ^ ((name[i]! << (off & 0x1f)) >>> 0)) >>> 0;
    off += 8;
  }
  const lo = acc;
  acc = 0; off = 0;
  for (let i = half; i < name.length; i++) {
    const temp = (name[i]! << (off & 0x1f)) >>> 0;
    acc = (acc ^ temp) >>> 0;
    const n = temp & 0x1f;
    if (n) acc = ((acc << (32 - n)) | (acc >>> n)) >>> 0;
    off += 8;
  }
  return { lo, hi: acc };
}

/** Data offsets are u32: an archive whose data block would exceed this cannot be written. */
export const BSA_MAX_DATA = 0xffffffff;

type Entry = { raw: Buffer; path: string; size: number; lo: number; hi: number; nameOff: number; dataOff: number };

/**
 * Write `out` from `files` (archive name -> path on disk). Names are normalised here (lowercase,
 * backslashes), so callers pass them as they appear on disk.
 *
 * Data offsets are u32, so a mod whose assets pass 4 GiB (Tamriel_Data HD) cannot be one
 * archive. The sorted list is split greedily into `<out>-1.bsa`, `<out>-2.bsa`, ... each under
 * `maxData`; a single archive keeps the plain name. Returns every path written, in order.
 * `maxData` is a parameter so a test can force the split without 4 GB of fixtures.
 */
export async function writeBsa(
  out: string, files: { name: string; path: string; size: number }[], maxData = BSA_MAX_DATA,
): Promise<string[]> {
  const entries: Entry[] = files.map((f) => {
    const raw = Buffer.from(f.name.replace(/\//g, '\\').toLowerCase(), 'latin1');
    return { raw, path: f.path, size: f.size, ...tes3Hash(raw), nameOff: 0, dataOff: 0 };
  });
  entries.sort((a, b) => (a.lo - b.lo) || (a.hi - b.hi));

  const parts: Entry[][] = [[]];
  let partLen = 0;
  for (const e of entries) {
    if (e.size > maxData) throw new Error(`bsa-pack: ${e.path} (${e.size} bytes) exceeds the u32 offset limit on its own`);
    if (partLen + e.size > maxData) { parts.push([]); partLen = 0; }
    parts[parts.length - 1]!.push(e);
    partLen += e.size;
  }
  if (parts.length === 1) { await writeOne(out, entries); return [out]; }
  const written: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const path = out.replace(/(\.bsa)?$/i, `-${i + 1}$1`);
    await writeOne(path, parts[i]!);
    written.push(path);
  }
  return written;
}

async function writeOne(out: string, entries: Entry[]): Promise<void> {
  const names: Buffer[] = [];
  let nameLen = 0;
  let dataLen = 0;
  for (const e of entries) {
    e.nameOff = nameLen;
    names.push(e.raw, Buffer.alloc(1));
    nameLen += e.raw.length + 1;
    e.dataOff = dataLen;
    dataLen += e.size;
  }
  if (dataLen > BSA_MAX_DATA) throw new Error(`bsa-pack: ${dataLen} bytes of data exceeds the u32 offset limit`);

  const count = entries.length;
  const header = Buffer.alloc(12 + 12 * count);
  header.writeUInt32LE(0x100, 0);
  header.writeUInt32LE(12 * count + nameLen, 4);
  header.writeUInt32LE(count, 8);
  const hashes = Buffer.alloc(8 * count);
  entries.forEach((e, i) => {
    header.writeUInt32LE(e.size, 12 + 8 * i);
    header.writeUInt32LE(e.dataOff, 16 + 8 * i);
    header.writeUInt32LE(e.nameOff, 12 + 8 * count + 4 * i);
    hashes.writeUInt32LE(e.lo, 8 * i);
    hashes.writeUInt32LE(e.hi, 8 * i + 4);
  });

  const fh = await open(out, 'w');
  try {
    await fh.write(Buffer.concat([header, ...names, hashes]));
    for (const e of entries) {
      const data = await readFile(e.path);
      if (data.length !== e.size) throw new Error(`bsa-pack: ${e.path} changed size while packing`);
      await fh.write(data);
    }
  } finally {
    await fh.close();
  }
}

/** Parse a BSA's directory back: the stored names and sizes, in record order. */
export function readBsaNames(buf: Buffer): { name: string; size: number }[] {
  if (buf.readUInt32LE(0) !== 0x100) throw new Error('not a TES3 BSA');
  const hashOffset = buf.readUInt32LE(4);
  const count = buf.readUInt32LE(8);
  const nameBlock = buf.subarray(12 + 12 * count, 12 + hashOffset);
  const out = [];
  for (let i = 0; i < count; i++) {
    const nameOff = buf.readUInt32LE(12 + 8 * count + 4 * i);
    const end = nameBlock.indexOf(0, nameOff);
    out.push({ name: nameBlock.toString('latin1', nameOff, end), size: buf.readUInt32LE(12 + 8 * i) });
  }
  return out;
}
