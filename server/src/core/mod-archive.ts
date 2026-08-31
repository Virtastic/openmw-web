// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Finding the game data inside a mod archive.
//
// THIS IS THE STEP EVERY OTHER TOOL HANDS TO A HUMAN. Nexus has no packaging standard for
// Morrowind: the data folder may be at the archive root, or under "00 Core", or under the mod's
// own name, and an archive routinely carries several — a core install, optional textures, a
// compatibility patch. Every guide says "find the folder with Meshes and Textures in it". So
// this does the finding, and where the answer is genuinely ambiguous it presents the options
// rather than guessing: installing the wrong variant produces a game that starts and then breaks
// somewhere far from here.
//
// Nothing is extracted. This reads the central directory's path list only.

/** Plugins. `.omwscripts` is here because a Lua mod is a mod, and the rest of this codebase
 *  had forgotten they exist. */
export const PLUGIN_EXT = /\.(esp|esm|omwaddon|omwgame|omwscripts)$/i;
export const ARCHIVE_EXT = /\.(bsa|ba2)$/i;

/**
 * Folder names Morrowind itself uses inside Data Files. A directory holding one of these is
 * a data folder even with no plugin at all — texture and mesh replacers are exactly that.
 */
const VANILLA_DIRS = new Set([
  'meshes', 'textures', 'icons', 'sound', 'bookart', 'fonts', 'music', 'splash', 'video',
  'scripts', 'shaders', 'mwse', 'distantland',
]);

/** Never data, whatever else they contain. */
const IGNORED_DIRS = new Set(['fomod', '__macosx', 'docs', 'optional files']);

export interface Candidate {
  /** Path inside the archive. '' means the archive root itself is the data folder. */
  path: string;
  plugins: string[];
  archives: string[];
  /** Vanilla-shaped asset directories directly inside this folder. */
  assetDirs: string[];
  files: number;
  bytes: number;
}

interface Listed { path: string; size: number; isDir: boolean }

const dirOf = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

const baseOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/**
 * Which folders in this archive look like game data.
 *
 * THE ANCESTOR RULE IS THE WHOLE ALGORITHM: a folder qualifies when it directly contains a
 * plugin, an archive or a vanilla-shaped asset directory, AND no folder above it already
 * qualified. That single condition produces the right answer for every shape these archives
 * come in:
 *
 *   root has Foo.esp + Meshes/          -> one candidate at the root; the subfolders are its
 *                                          CONTENT, not alternatives to it
 *   root has only 00 Core/ + 01 Opt/    -> two candidates, because the root itself has nothing
 *   MyMod/Data Files/Foo.esp            -> one candidate, however deeply it is buried
 *   root has Meshes/ AND Extra/Foo.esp  -> one candidate at the root. Conservative on purpose:
 *                                          it is one data folder with an extra subfolder, and
 *                                          the operator can see the file list and say otherwise.
 */
export function findDataFolders(entries: Listed[]): Candidate[] {
  const skipped = (p: string): boolean =>
    p.split('/').some((s) => IGNORED_DIRS.has(s.toLowerCase()) || s.startsWith('.'));

  // What each directory holds DIRECTLY. Every directory in the archive gets an entry, including
  // ones that only ever appear as a parent, so the ancestor walk below cannot miss a level.
  const direct = new Map<string, { plugins: string[]; archives: string[]; subDirs: Set<string> }>();
  const touch = (d: string): NonNullable<ReturnType<typeof direct.get>> => {
    let e = direct.get(d);
    if (!e) { e = { plugins: [], archives: [], subDirs: new Set() }; direct.set(d, e); }
    return e;
  };
  touch('');

  for (const e of entries) {
    if (skipped(e.path)) continue;
    const parent = dirOf(e.path);
    const name = baseOf(e.path);
    if (e.isDir) {
      touch(e.path);
      touch(parent).subDirs.add(name);
    } else {
      const p = touch(parent);
      if (PLUGIN_EXT.test(name)) p.plugins.push(name);
      else if (ARCHIVE_EXT.test(name)) p.archives.push(name);
    }
    // Intermediate directories are not always listed as their own entries, so walk the path up
    // and register each level. Without this, "a/b/c.esp" leaves "a" unknown and the ancestor
    // check below cannot see it.
    let cur = parent;
    while (cur !== '') {
      const up = dirOf(cur);
      touch(cur);
      touch(up).subDirs.add(baseOf(cur));
      cur = up;
    }
  }

  const qualifies = (d: string): boolean => {
    const e = direct.get(d);
    if (!e) return false;
    if (e.plugins.length > 0 || e.archives.length > 0) return true;
    for (const s of e.subDirs) if (VANILLA_DIRS.has(s.toLowerCase())) return true;
    return false;
  };

  const hasQualifyingAncestor = (d: string): boolean => {
    let cur = dirOf(d);
    for (;;) {
      if (qualifies(cur)) return true;
      if (cur === '') return false;
      cur = dirOf(cur);
    }
  };

  const out: Candidate[] = [];
  for (const d of [...direct.keys()].sort()) {
    if (skipped(d) || !qualifies(d)) continue;
    if (d !== '' && hasQualifyingAncestor(d)) continue;
    const e = direct.get(d)!;
    const prefix = d === '' ? '' : `${d}/`;
    let files = 0;
    let bytes = 0;
    for (const f of entries) {
      if (f.isDir || skipped(f.path)) continue;
      if (d === '' || f.path.startsWith(prefix)) { files++; bytes += f.size; }
    }
    out.push({
      path: d,
      plugins: e.plugins.sort((a, b) => a.localeCompare(b)),
      archives: e.archives.sort((a, b) => a.localeCompare(b)),
      assetDirs: [...e.subDirs].filter((s) => VANILLA_DIRS.has(s.toLowerCase())).sort(),
      files,
      bytes,
    });
  }

  // Most likely first: something with a plugin, then the biggest. The operator reads top-down and
  // the thing they almost certainly want should not be third.
  out.sort((a, b) => (b.plugins.length > 0 ? 1 : 0) - (a.plugins.length > 0 ? 1 : 0)
    || b.files - a.files || a.path.localeCompare(b.path));
  return out;
}

/** A folder name for a mod: lowercase, hyphenated, safe as a single path segment. */
export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/\.zip$/i, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 64);
  // "mods" would nest inside itself, and an empty slug would resolve to the mods root and let a
  // delete take every mod with it.
  return s === '' || s === 'mods' ? `mod-${Date.now().toString(36)}` : s;
}
