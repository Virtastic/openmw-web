// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 3.5.2b: build the approved-mod whitelist from the archives an operator downloaded.
//
// WHY A GENERATOR AND NOT A CHECKED-IN LIST. The whitelist is thousands of per-file
// hashes; hand-maintaining it guarantees drift the first time a mod ships a hotfix. This
// reads the archives, records what is in them, and writes one artifact the server loads.
//
// WHAT IS AND IS NOT COMMITTED. The manifest (names, sizes, sha256, tier, load order) is
// committed. The ARCHIVES ARE NOT, and neither is any file from inside them: we have no
// redistribution right, and two of the three are mesh/texture works whose authors' terms
// are the operative permission (docs/LEGAL.md §7). This tool reads from wherever the
// operator downloaded them and never copies content into the repo.
//
// Usage:
//   node wasm-build/gen-mod-manifest.mjs ~/Downloads/ASDF
//   node wasm-build/gen-mod-manifest.mjs ~/Downloads/ASDF --out server/data/mod-manifest.json

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// The approved bundle. Order IS the load order: MOP's optimized meshes first, Atlas's
// atlased ones over them, Weapon Sheathing last (it only adds animation/mesh variants).
//
// tier: 'cosmetic'  meshes/textures — may differ between players in one world, because
//                   they change nothing the simulation reads.
//       'content'   record-bearing plugins (.esp/.esm) — must MATCH across a world, since
//                   two players with different records disagree about the game itself.
const BUNDLE = [
  {
    id: 'mop',
    name: 'Morrowind Optimization Patch',
    nexus: 'https://www.nexusmods.com/morrowind/mods/45384',
    match: /^Morrowind Optimization Patch/i,
  },
  {
    id: 'project-atlas',
    name: 'Project Atlas',
    nexus: 'https://www.nexusmods.com/morrowind/mods/45399',
    source: 'https://github.com/MelchiorDahrk/Project-Atlas',
    match: /^Project Atlas/i,
  },
  {
    id: 'weapon-sheathing',
    name: 'Weapon Sheathing (OpenMW)',
    nexus: 'https://www.nexusmods.com/morrowind/mods/46069',
    match: /^WeaponSheathing.*OpenMW/i,
    // The mod ships several variants; only the OpenMW one works here, and picking the
    // wrong file is a support question that costs an hour. The manifest records which
    // variant was hashed so the client can say "that is the MWSE build" rather than
    // "unknown file".
    variantNote: 'use the 1.6-OpenMW download, not the MWSE build',
    settings: {
      // The launcher applies these; without them the meshes load and nothing sheathes,
      // which reads as "the mod does not work".
      'weapon sheathing': 'true',
      'shield sheathing': 'true',
      'use additional anim sources': 'true',
    },
  },
];

const CONTENT_EXT = /\.(esp|esm|omwaddon)$/i;

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

function main() {
  const src = process.argv[2];
  if (!src) {
    console.error('usage: node wasm-build/gen-mod-manifest.mjs <dir-with-archives> [--out <path>]');
    process.exit(2);
  }
  const outIdx = process.argv.indexOf('--out');
  const outPath = outIdx !== -1 ? process.argv[outIdx + 1] : join(ROOT, 'server', 'data', 'mod-manifest.json');

  const archives = readdirSync(src).filter((n) => /\.(7z|zip|rar)$/i.test(n));
  const mods = [];

  for (const [order, spec] of BUNDLE.entries()) {
    const archive = archives.find((n) => spec.match.test(n));
    if (!archive) {
      console.error(`! ${spec.name}: no archive matching ${spec.match} in ${src} — skipped`);
      continue;
    }
    const tmp = mkdtempSync(join(tmpdir(), `modman-${spec.id}-`));
    try {
      // -y so a re-run never blocks on an overwrite prompt; stdio ignored because 7z is
      // chatty and the useful output is ours.
      execFileSync('7z', ['x', '-y', `-o${tmp}`, join(src, archive)], { stdio: 'ignore' });
      const files = walk(tmp).sort();
      const entries = files.map((rel) => {
        const full = join(tmp, rel);
        return {
          path: rel,
          size: statSync(full).size,
          sha256: sha256(full),
          tier: CONTENT_EXT.test(rel) ? 'content' : 'cosmetic',
        };
      });
      const contentFiles = entries.filter((e) => e.tier === 'content').map((e) => e.path);
      mods.push({
        id: spec.id,
        name: spec.name,
        order,
        archive, // the exact download this manifest describes (version is in the filename)
        nexus: spec.nexus,
        ...(spec.source ? { source: spec.source } : {}),
        ...(spec.variantNote ? { variantNote: spec.variantNote } : {}),
        ...(spec.settings ? { settings: spec.settings } : {}),
        contentFiles,
        fileCount: entries.length,
        totalBytes: entries.reduce((a, e) => a + e.size, 0),
        files: entries,
      });
      console.log(
        `${spec.name}: ${entries.length} files, ` +
        `${(entries.reduce((a, e) => a + e.size, 0) / 1e6).toFixed(1)} MB, ` +
        `${contentFiles.length} record-bearing (${contentFiles.join(', ') || 'none'})`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const doc = {
    generatedFrom: BUNDLE.map((b) => b.id),
    // No timestamp: the manifest must be REPRODUCIBLE from the same archives, and a date
    // would make every regeneration a diff even when nothing changed.
    mods,
  };
  writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');
  console.log(`\nwrote ${outPath} (${mods.length}/${BUNDLE.length} mods)`);
}

main();
