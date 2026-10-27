// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Write the `items` list of <sharedDir>/content-table.json: every carryable item record id in
// the content files you give it. With it present the server drops inventory entries naming an
// id no content defines (core/content-table.ts isKnownItem). Other keys in an existing table
// are kept.
//
// Run it over EVERY content file the deployment loads (masters and mods): an item a mod adds
// that is missing here is dropped from that player's saved inventory.
//
// Usage:
//   node server/tools/gen-content-table.mjs --out <sharedDir>/content-table.json \
//        "/path/Data Files/Morrowind.esm" ".../Tribunal.esm" ".../Bloodmoon.esm" [mods...]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ITEM_TYPES = new Set(['WEAP', 'ARMO', 'CLOT', 'MISC', 'BOOK', 'ALCH', 'INGR', 'APPA', 'LOCK', 'PROB', 'REPA', 'LIGH']);

function itemIds(path) {
  const b = readFileSync(path);
  if (b.toString('latin1', 0, 4) !== 'TES3') throw new Error(`${path}: not a TES3 file`);
  const ids = [];
  // Record: type(4) size(4) unused(4) flags(4), then `size` bytes of subrecords name(4) len(4) data.
  for (let p = 0; p + 16 <= b.length;) {
    const type = b.toString('latin1', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    const end = p + 16 + size;
    if (ITEM_TYPES.has(type)) {
      for (let q = p + 16; q + 8 <= end;) {
        const len = b.readUInt32LE(q + 4);
        if (b.toString('latin1', q, q + 4) === 'NAME') {
          const id = b.toString('latin1', q + 8, q + 8 + len).replace(/\0.*$/s, '');
          if (id) ids.push(id.toLowerCase());
          break;
        }
        q += 8 + len;
      }
    }
    p = end;
  }
  return ids;
}

const args = process.argv.slice(2);
const o = args.indexOf('--out');
if (o === -1 || !args[o + 1]) { console.error('usage: gen-content-table.mjs --out <file> <content files...>'); process.exit(2); }
const out = args[o + 1];
const files = args.filter((_, i) => i !== o && i !== o + 1);
if (files.length === 0) { console.error('no content files given'); process.exit(2); }

const items = new Set();
for (const f of files) {
  const ids = itemIds(f);
  ids.forEach((id) => items.add(id));
  console.log(`${f}: ${ids.length} item records`);
}
const doc = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
doc.items = [...items].sort();
writeFileSync(out, JSON.stringify(doc, null, 1) + '\n');
console.log(`${out}: ${doc.items.length} distinct item ids`);
