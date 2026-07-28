// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Generate <sharedDir>/vanilla-manifest.json — the sha256 allow-list the locker checks
// uploads against, so it only ever accepts real retail Morrowind files and can never
// become general file hosting (docs/LEGAL.md §2).
//
// You run this against YOUR OWN legally-acquired Data Files. The hashes are yours to
// publish for your deployment; we deliberately do not ship Bethesda's hashes.
//
// Usage:
//   node server/tools/gen-vanilla-manifest.mjs "/path/to/Morrowind/Data Files" \
//        --out server/devdata/vanilla-manifest.json
//
// Then point the server's shared dir at that file (it looks for vanilla-manifest.json in
// the --shared dir, or the --data dir for a single-world server).

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const CORE = /\.(esm|esp|bsa|omwaddon)$/i; // the files the game loads; anything else is noise

async function sha256(path) {
  const h = createHash('sha256');
  return new Promise((res, rej) => {
    createReadStream(path).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

async function walk(dir, out = []) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) await walk(full, out);
    else if (ent.isFile() && CORE.test(ent.name)) out.push(full);
  }
  return out;
}

async function main() {
  const src = process.argv[2];
  if (!src) {
    console.error('usage: node tools/gen-vanilla-manifest.mjs <Data Files dir> [--out <path>]');
    process.exit(2);
  }
  const outIdx = process.argv.indexOf('--out');
  const out = outIdx !== -1 ? process.argv[outIdx + 1] : 'vanilla-manifest.json';

  const files = await walk(src);
  const records = [];
  for (const f of files) {
    const size = (await stat(f)).size;
    const name = relative(src, f).split(/[\\/]/).pop(); // bare filename: the game loads by name
    const hash = await sha256(f);
    records.push({ name, size, sha256: hash });
    console.log(`${name}  ${(size / 1e6).toFixed(1)}MB  ${hash.slice(0, 12)}…`);
  }
  const { writeFile } = await import('node:fs/promises');
  await writeFile(out, JSON.stringify({ files: records }, null, 2) + '\n');
  console.log(`\nwrote ${out} (${records.length} files) — copy it into the server's shared/data dir as vanilla-manifest.json`);
}

main();
