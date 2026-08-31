// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// A small, deliberately suspicious ZIP reader.
//
// WHY NOT SHELL OUT TO unzip. The image has it, and ops.ts already shells out to tar for the
// backup export, so the precedent exists. The difference is the input: a backup is a file this
// server wrote, and a mod archive is a file a stranger uploaded. Zip-slip — an entry named
// ../../etc/something — has to be OUR guarantee, made once, in a place a test can point at.
// Handing the bytes to a binary and hoping its extraction rules match ours is not that.
//
// WHY NOT A DEPENDENCY. Three runtime dependencies is the whole tree, and this codebase
// hand-rolls TOTP and an SMTP client rather than add a fourth. The parts of ZIP a mod archive
// actually uses are the central directory, stored and deflate — and node:zlib already does the
// only hard part.
//
// READ THROUGH A FILE DESCRIPTOR, never the whole file into memory. A mod archive is routinely
// hundreds of megabytes; the locker learned this the same way and streams for the same reason.

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/** One file in the archive. Directories are recorded too, so an empty one is not silently lost. */
export interface ZipEntry {
  /** Forward-slashed, no leading slash. Still UNTRUSTED — see safeJoin. */
  path: string;
  /** Uncompressed size in bytes. */
  size: number;
  compressedSize: number;
  /** 0 = stored, 8 = deflate. Anything else is refused at read time. */
  method: number;
  /** Offset of the LOCAL header, which is where the data actually lives. */
  offset: number;
  isDir: boolean;
  crc32: number;
}

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  /** Refuse an entry that expands by more than this. See the zip-bomb note in readEntry. */
  maxRatio: number;
}

export const DEFAULT_LIMITS: ZipLimits = {
  maxEntries: 20_000,
  // A single BSA can legitimately be hundreds of MB; Morrowind.bsa alone is ~300.
  maxEntryBytes: 4 * 1024 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
  maxRatio: 200,
};

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN = 22;
/** The comment is a uint16 length, so the record can be this far from the end and no further. */
const EOCD_MAX_SCAN = EOCD_MIN + 0xffff;

/** CRC-32, so a truncated or corrupt entry is caught rather than written out as game data. */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Normalise an entry path, or return null if it is one we will not touch.
 *
 * Refused here rather than at extraction so a hostile archive is rejected while being LISTED,
 * before anything has been written. Backslashes are normalised because Windows-built archives
 * use them, and a path that mixes both must not sneak a segment past the '..' check.
 */
export function normaliseEntryPath(raw: string): string | null {
  if (raw === '' || raw.includes('\0')) return null;
  const p = raw.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.length === 0) return null;
  for (const s of segs) {
    if (s === '..') return null;
    if (s.length > 200) return null;
  }
  return segs.join('/');
}

/** Read a zip's central directory. Nothing is decompressed here. */
export function listEntries(zipPath: string, limits: ZipLimits = DEFAULT_LIMITS): ZipEntry[] {
  const fd = openSync(zipPath, 'r');
  try {
    const fileSize = statSync(zipPath).size;
    if (fileSize < EOCD_MIN) throw new ZipError('this file is too small to be a zip archive');

    // The End of Central Directory record sits at the very end unless the archive carries a
    // comment, so scan backwards over the maximum a comment can be.
    const scan = Math.min(fileSize, EOCD_MAX_SCAN);
    const tail = Buffer.alloc(scan);
    readSync(fd, tail, 0, scan, fileSize - scan);
    let eocd = -1;
    for (let i = scan - EOCD_MIN; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) {
      // The overwhelmingly likely cause, so say it rather than "bad archive".
      throw new ZipError('this does not look like a zip archive. If it is a .rar or .7z, '
        + 're-save it as a .zip and try again.');
    }

    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new ZipError('this archive uses the ZIP64 format, which is not supported. '
        + 'Re-save it as a normal zip.');
    }
    if (total > limits.maxEntries) {
      throw new ZipError(`this archive holds ${total} files, more than the ${limits.maxEntries} limit`);
    }
    if (cdOffset + cdSize > fileSize) throw new ZipError('this archive is truncated or corrupt');

    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOffset);

    const out: ZipEntry[] = [];
    let running = 0;
    let p = 0;
    for (let i = 0; i < total; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CD_SIG) {
        throw new ZipError('this archive is truncated or corrupt');
      }
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const compressedSize = cd.readUInt32LE(p + 20);
      const size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const offset = cd.readUInt32LE(p + 42);
      const rawName = cd.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;

      // Bit 0 = encrypted. There is no password to ask for and a partial install is worse than
      // a refusal, so this ends the whole archive rather than skipping the entry.
      if (flags & 0x1) throw new ZipError('this archive is password-protected');

      const isDir = rawName.endsWith('/') || rawName.endsWith('\\');
      const path = normaliseEntryPath(rawName);
      if (path === null) {
        throw new ZipError(`this archive contains an unsafe path (${rawName.slice(0, 80)}) `
          + 'and was refused entirely');
      }
      if (size > limits.maxEntryBytes) throw new ZipError(`${path} is larger than the size limit`);
      running += size;
      if (running > limits.maxTotalBytes) throw new ZipError('this archive unpacks to more than the size limit');

      out.push({ path, size, compressedSize, method, offset, isDir, crc32: crc });
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

/**
 * Decompress one entry.
 *
 * The compressed size in the CENTRAL directory is trusted for the read window, but the ratio and
 * the CRC are checked against what actually came out: a zip bomb declares a small compressed size
 * and an enormous real one, and a truncated archive declares a size it cannot deliver. Neither is
 * detectable from the header alone.
 */
export function readEntry(
  zipPath: string,
  entry: ZipEntry,
  limits: ZipLimits = DEFAULT_LIMITS,
): Buffer {
  if (entry.isDir) return Buffer.alloc(0);
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipError(`${entry.path} uses an unsupported compression method (${entry.method})`);
  }
  if (entry.compressedSize > 0 && entry.size / entry.compressedSize > limits.maxRatio
      && entry.size > 10 * 1024 * 1024) {
    throw new ZipError(`${entry.path} expands ${Math.round(entry.size / entry.compressedSize)}x, `
      + 'which looks like a decompression bomb');
  }

  const fd = openSync(zipPath, 'r');
  try {
    // The local header repeats the name and extra fields, and its extra length routinely DIFFERS
    // from the central directory's. Read it rather than assuming, or the data window starts in
    // the wrong place.
    const head = Buffer.alloc(30);
    readSync(fd, head, 0, 30, entry.offset);
    if (head.readUInt32LE(0) !== LOCAL_SIG) throw new ZipError(`${entry.path} is corrupt`);
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const dataAt = entry.offset + 30 + nameLen + extraLen;

    const raw = Buffer.alloc(entry.compressedSize);
    const got = readSync(fd, raw, 0, entry.compressedSize, dataAt);
    if (got !== entry.compressedSize) throw new ZipError(`${entry.path} is truncated`);

    let out: Buffer;
    if (entry.method === 0) {
      out = raw;
    } else {
      try {
        out = inflateRawSync(raw, { maxOutputLength: Math.min(limits.maxEntryBytes, entry.size + 1024) });
      } catch (e) {
        throw new ZipError(`${entry.path} could not be decompressed (${String((e as Error).message)})`);
      }
    }
    if (out.length !== entry.size) throw new ZipError(`${entry.path} is truncated or corrupt`);
    if (crc32(out) !== entry.crc32) throw new ZipError(`${entry.path} failed its checksum`);
    return out;
  } finally {
    closeSync(fd);
  }
}
