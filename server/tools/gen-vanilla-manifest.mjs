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
// POINT IT AT A REAL Data Files TREE, never play/mwdata. That directory keeps the media as
// pre-packed tars (mwvoice.tar, mwaudio.tar, mwvideo.tar…), not as the loose Sound/, Music/
// and Video/ folders this scans — so it silently emits a manifest of SIX files. The server
// then asks uploaders for the ESMs and BSAs only, everything installs "successfully", and
// the game runs with no voice, no music and no intro. A manifest that covers a real install
// has ~6,443 entries; six means you pointed it at the wrong tree.
// (To rebuild from the tars anyway: extract them all into one directory alongside the
// .esm/.bsa files and run this over that.)
//
// Then point the server's shared dir at that file (it looks for vanilla-manifest.json in
// the --shared dir, or the --data dir for a single-world server).

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

// The plugins/archives the game loads BY NAME (no directory: openmw.cfg lists them bare).
const CORE = /\.(esm|esp|bsa|omwaddon)$/i;
// Retail Morrowind keeps voice, music, videos, fonts and splashes as LOOSE FILES beside the
// BSAs — they are NOT inside them. Omitting these is why a locker-only install has no music,
// no intro video, and dialogue that auto-skips (there is no voice file to wait on). These are
// matched by RELATIVE PATH, since the engine loads them by path and names repeat across dirs.
const MEDIA_DIRS = /^(Sound|Music|Video|Fonts|Splash|BookArt|Icons|Textures|Meshes)([\\/]|$)/i;
const MEDIA_EXT = /\.(mp3|wav|bik|fnt|tex|dds|tga|bmp|zip)$/i;

async function sha256(path) {
  const h = createHash('sha256');
  return new Promise((res, rej) => {
    createReadStream(path).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

async function walk(dir, root, out = []) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) await walk(full, root, out);
    else if (ent.isFile()) {
      const rel = relative(root, full);
      if (CORE.test(ent.name) || (MEDIA_DIRS.test(rel) && MEDIA_EXT.test(ent.name))) out.push(full);
    }
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

  const files = await walk(src, src);
  const records = [];
  for (const f of files) {
    const size = (await stat(f)).size;
    const rel = relative(src, f).split(/[\\/]/).join('/');
    // Plugins/archives are loaded BY NAME (openmw.cfg lists them bare); loose media is loaded
    // BY PATH (Sound/Vo/..., Video/...), so media entries keep their relative path.
    const name = CORE.test(f) ? rel.split('/').pop() : rel;
    const hash = await sha256(f);
    records.push({ name, size, sha256: hash });
    console.log(`${name}  ${(size / 1e6).toFixed(1)}MB  ${hash.slice(0, 12)}…`);
  }
  const { writeFile } = await import('node:fs/promises');
  await writeFile(out, JSON.stringify({ files: records }, null, 2) + '\n');
  console.log(`\nwrote ${out} (${records.length} files) — copy it into the server's shared/data dir as vanilla-manifest.json`);
}

main();
