// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The TES3 record walk shared by gen-content-table.mjs and scan-quests.mjs.
//
// Record: type(4) size(4) unused(4) flags(4), then `size` bytes of subrecords name(4) len(4) data.

import { readFileSync } from 'node:fs';

/** Yields { type, flags, subs: [[name, Buffer]] } for every record of a TES3 file. */
export function* readRecords(path) {
  const b = readFileSync(path);
  if (b.toString('latin1', 0, 4) !== 'TES3') throw new Error(`${path}: not a TES3 file`);
  for (let p = 0; p + 16 <= b.length;) {
    const type = b.toString('latin1', p, p + 4);
    const end = p + 16 + b.readUInt32LE(p + 4);
    if (end > b.length) throw new Error(`${path}: ${type} record at ${p} runs past the end of the file`);
    const flags = b.readUInt32LE(p + 12);
    const subs = [];
    for (let q = p + 16; q + 8 <= end;) {
      const name = b.toString('latin1', q, q + 4), len = b.readUInt32LE(q + 4);
      subs.push([name, b.subarray(q + 8, q + 8 + len)]);
      q += 8 + len;
    }
    yield { type, flags, subs };
    p = end;
  }
}

/** A NUL-terminated (or not) latin1 string subrecord. */
export const zstr = (buf) => (buf ? buf.toString('latin1').replace(/\0.*$/s, '') : '');

/** The first subrecord of that name, or undefined. */
export const sub = (rec, name) => rec.subs.find(([k]) => k === name)?.[1];
