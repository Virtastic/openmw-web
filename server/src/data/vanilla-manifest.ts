// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Building the locker's allow-list from a real Data Files tree.
//
// The manifest is the sha256 allow-list uploads are checked against, so the locker only ever
// accepts genuine retail Morrowind files and can never become general file hosting
// (docs/LEGAL.md §2). It is derived from the OPERATOR'S OWN legally-acquired copy — we ship
// no hashes of Bethesda's files, and generating them on the operator's own machine from the
// data they already had is the same act the CLI tool has always performed, just automatic.
//
// Lives here rather than only in tools/ because the server can do this itself: it already
// REFUSES TO START without real game data (see startServer), so the input is guaranteed
// present. An operator who had to know to run a script got a server that looked healthy and
// told every player "this server has no game manifest configured yet".
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat, writeFile, access, rename } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { log } from '../log';
import type { VanillaManifest } from './locker';

// Plugins and archives are loaded BY NAME (openmw.cfg lists them bare). Loose media is loaded
// BY PATH, so those entries keep their relative path.
const CORE = /\.(esm|esp|bsa|omwaddon)$/i;
const MEDIA_DIRS = /^(Sound|Music|Video|Fonts|Splash|BookArt|Icons|Textures|Meshes)([\\/]|$)/i;
const MEDIA_EXT = /\.(mp3|wav|bik|fnt|tex|dds|tga|bmp|zip)$/i;

function sha256(path: string): Promise<string> {
  const h = createHash('sha256');
  return new Promise((res, rej) => {
    createReadStream(path)
      .on('data', (c) => h.update(c as Buffer))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej);
  });
}

async function walk(dir: string, root: string, out: string[] = []): Promise<string[]> {
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

/** Hash a Data Files tree into a manifest. Point at a REAL install, never play/mwdata: that
 *  keeps media as pre-packed tars, so it yields a manifest of about six files and the server
 *  then asks uploaders for the ESMs alone — the game installs "fine" and runs with no voice,
 *  no music and no intro. A real install produces thousands of entries. */
export async function buildVanillaManifest(dataFilesDir: string): Promise<VanillaManifest> {
  const files = await walk(dataFilesDir, dataFilesDir);
  const records = [];
  for (const f of files) {
    const size = (await stat(f)).size;
    const rel = relative(dataFilesDir, f).split(/[\\/]/).join('/');
    records.push({
      name: CORE.test(f) ? (rel.split('/').pop() as string) : rel,
      size,
      sha256: await sha256(f),
    });
  }
  return { files: records };
}

/** Write <sharedDir>/vanilla-manifest.json from the server's own game data if it is not
 *  already there. Returns true if it generated one. Never throws: a locker that cannot be
 *  configured must not stop the server from running single-player-adjacent work. */
export async function ensureVanillaManifest(sharedDir: string, dataFilesDir: string): Promise<boolean> {
  const out = join(sharedDir, 'vanilla-manifest.json');
  try {
    await access(out);
    return false; // already present; an operator-supplied one always wins
  } catch { /* not there — build it below */ }
  try {
    // Hashing a full install is minutes of I/O on first boot and nothing thereafter. Say so,
    // or it reads as a hang.
    log('info', 'locker.manifest_generating', { from: dataFilesDir, note: 'first boot only' });
    const manifest = await buildVanillaManifest(dataFilesDir);
    if (manifest.files.length === 0) {
      log('warn', 'locker.manifest_empty', { from: dataFilesDir,
        reason: 'no game files found — uploads will be refused until a manifest exists' });
      return false;
    }
    // The world process and the front door both run this and neither sees the file until one
    // finishes, so on a fresh server they generate concurrently. Write to a private temp path
    // and rename: rename is atomic, so a reader sees either no file or a complete one, never
    // two interleaved writes of the same JSON.
    const tmp = `${out}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n');
    await rename(tmp, out);
    log('info', 'locker.manifest_generated', { path: out, files: manifest.files.length });
    return true;
  } catch (err) {
    log('error', 'locker.manifest_generate_failed', { error: String(err) });
    return false;
  }
}
