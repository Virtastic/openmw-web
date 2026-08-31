// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Which files a plugin needs loaded before it.
//
// WHY THIS EXISTS. A plugin declares its masters in its own header, and OpenMW ABORTS at startup
// when one is missing — not "skips the mod", aborts. From the player's side that is a black
// screen with no message. So the dashboard has to be able to say "switching this off will break
// that" BEFORE the save, and the browser has to be able to drop a plugin whose master did not
// make it rather than emit a content= line that kills the boot.
//
// Only the header is read: the first record of a .esm/.esp is TES3, and the masters are in it.
// Nothing here parses game records, and it must not start to — that is a different project and
// core/manifest.ts already explains why a server-side content list cannot be authoritative.

import { closeSync, openSync, readSync } from 'node:fs';

/** How far in we are willing to look. The TES3 record is first and small; a plugin whose header
 *  runs past this is not one we can usefully reason about. */
const MAX_HEADER = 1 << 20;

/**
 * The masters a plugin declares, in the order it declares them.
 *
 * Returns [] for anything unreadable, truncated, or not a TES3 file. A plugin we cannot parse
 * is reported as depending on nothing, which is the safe direction: it means no false warning
 * about a dependency that may not exist, and the engine remains the final authority either way.
 */
export function readMasters(path: string): string[] {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return []; }
  try {
    const head = Buffer.alloc(16);
    if (readSync(fd, head, 0, 16, 0) < 16) return [];
    if (head.toString('latin1', 0, 4) !== 'TES3') return [];

    // TES3 record: name(4) size(4) unused(4) flags(4), then `size` bytes of subrecords.
    const size = Math.min(head.readUInt32LE(4), MAX_HEADER);
    const body = Buffer.alloc(size);
    const got = readSync(fd, body, 0, size, 16);

    const masters: string[] = [];
    let p = 0;
    // Subrecord: name(4) size(4) data. MAST is a zero-terminated filename; the DATA that
    // follows it is the master's file size, which nothing here needs.
    while (p + 8 <= got) {
      const name = body.toString('latin1', p, p + 4);
      const len = body.readUInt32LE(p + 4);
      p += 8;
      if (len > got - p) break; // truncated
      if (name === 'MAST') {
        const raw = body.toString('latin1', p, p + len);
        const end = raw.indexOf('\0');
        const file = (end === -1 ? raw : raw.slice(0, end)).trim();
        if (file !== '') masters.push(file);
      }
      p += len;
    }
    return masters;
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}
