// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// .7z archives, which is half of what Nexus actually serves.
//
// WHY THIS ONE SHELLS OUT WHEN zip.ts DOES NOT. 7z is LZMA/LZMA2/BCJ and a container format to
// match; there is no node:zlib for it, so hand-rolling means porting a decompressor, which is a
// different project. p7zip is 1.7MB in the image and ops.ts already sets the precedent of using
// a binary that ships with the container.
//
// THE SAFETY POSTURE IS STILL OURS. The archive is LISTED first and every entry name is run
// through the same normaliseEntryPath the zip reader uses; a single unsafe name refuses the
// whole archive BEFORE anything is written. Only then is it extracted, into a directory of our
// choosing that holds nothing else. That ordering is the point: it means we never rely on
// p7zip's own opinion about what a safe path is.

import { spawn } from 'node:child_process';
import { openSync, readSync, closeSync } from 'node:fs';
import { normaliseEntryPath, ZipError, type ZipEntry } from './zip';

/** What an archive actually is, by its first bytes rather than its extension. */
export function sniffArchive(path: string): 'zip' | '7z' | 'rar' | 'unknown' {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return 'unknown'; }
  try {
    const b = Buffer.alloc(8);
    if (readSync(fd, b, 0, 8, 0) < 8) return 'unknown';
    if (b[0] === 0x50 && b[1] === 0x4b) return 'zip';                       // PK
    if (b.toString('latin1', 0, 6) === '7z\xbc\xaf\x27\x1c') return '7z';
    if (b.toString('latin1', 0, 4) === 'Rar!') return 'rar';
    return 'unknown';
  } finally {
    closeSync(fd);
  }
}

/** Run 7z, capturing stdout. Never inherits a shell: arguments are passed as an array. */
function run(args: string[], timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn('7z', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const kill = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d: Buffer) => { if (out.length < 32 * 1024 * 1024) out += d.toString(); });
    p.stderr.on('data', (d: Buffer) => { if (err.length < 64 * 1024) err += d.toString(); });
    p.on('error', () => { clearTimeout(kill); resolve({ code: -1, out, err: 'p7zip is not available' }); });
    p.on('close', (code) => { clearTimeout(kill); resolve({ code: code ?? -1, out, err }); });
  });
}

/**
 * The archive's contents, in the same shape the zip reader returns.
 *
 * `-slt` is 7z's machine-readable listing: blank-line separated records of `Key = Value`. The
 * `D` in Attributes marks a directory, which is how an empty folder is told from a zero-byte
 * file. Offsets and CRCs are not exposed here because nothing extracts a single entry: the
 * whole archive is unpacked in one call below.
 */
export async function listSevenZip(path: string, maxEntries = 20_000): Promise<ZipEntry[]> {
  const r = await run(['l', '-slt', '-y', '--', path], 5 * 60_000);
  if (r.code !== 0) {
    if (/not available/.test(r.err)) throw new ZipError('this server cannot open .7z archives');
    throw new ZipError('that .7z archive could not be read. It may be corrupt, or password-protected.');
  }
  if (/Encrypted = \+/.test(r.out)) throw new ZipError('this archive is password-protected');

  const out: ZipEntry[] = [];
  // Records start after the "----------" separator; everything before it is header noise,
  // including a `Path = <the archive itself>` line that must not become an entry.
  const body = r.out.slice(r.out.indexOf('----------'));
  for (const block of body.split(/\r?\n\r?\n/)) {
    const path7 = /^Path = (.*)$/m.exec(block)?.[1];
    if (path7 === undefined || path7 === '') continue;
    const isDir = /^Attributes = .*\bD/m.test(block);
    const size = Number(/^Size = (\d+)$/m.exec(block)?.[1] ?? 0);

    const norm = normaliseEntryPath(path7);
    if (norm === null) {
      throw new ZipError(`this archive contains an unsafe path (${path7.slice(0, 80)}) `
        + 'and was refused entirely');
    }
    if (out.length >= maxEntries) {
      throw new ZipError(`this archive holds more than the ${maxEntries} file limit`);
    }
    // offset/crc32 are meaningless for this format here; extraction is whole-archive.
    out.push({ path: norm, size: Number.isFinite(size) ? size : 0, compressedSize: 0,
      method: 0, offset: 0, isDir, crc32: 0 });
  }
  if (out.length === 0) throw new ZipError('that archive appears to be empty');
  return out;
}

/**
 * Unpack the whole archive into `dest`, which must be a directory nothing else uses.
 *
 * Whole-archive rather than per-entry because 7z has no cheap random access: pulling one file
 * at a time would re-walk a solid-compressed block for every one of them. The caller lists
 * first (which refuses unsafe names), then moves only the subtree the operator chose.
 */
export async function extractSevenZip(path: string, dest: string): Promise<void> {
  // -y answer yes, -bd no progress indicator, -o output dir, -- end of options so an archive
  // whose name begins with a dash cannot become one.
  const r = await run(['x', '-y', '-bd', `-o${dest}`, '--', path], 30 * 60_000);
  if (r.code !== 0) {
    throw new ZipError(`that .7z archive could not be unpacked${r.err ? `: ${r.err.trim().slice(0, 200)}` : ''}`);
  }
}
