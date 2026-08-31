// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Mod manager: which content files load, and in what order.
//
// Before this, load order was "whatever readdir returned, sorted alphabetically" — fine
// until two mods disagree about a record, which is exactly when order starts to matter and
// exactly when renaming files to force it becomes the only available tool.
//
// State lives in <dataDir>/modlist.json rather than config.toml: this is a list a
// drag-to-reorder UI rewrites constantly, and TOML's array-of-tables is a poor fit for
// something regenerated on every save.

import {
  existsSync, readdirSync, readFileSync, writeFileSync, renameSync, statSync,
  createWriteStream, mkdirSync, accessSync, constants, unlinkSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, basename, dirname, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '../../log';
import {
  MODLIST_FILE, MODS_SUBDIR, readModDoc, resolveMods, writeModDoc, type ModEntry,
} from '../../core/mods';

// The document, its schema and its migration live in core/mods.ts, so the load-order half of
// this file and the mod-manager half cannot drift into two readers of one file.
export { MODLIST_FILE };
export type { ModEntry };

/** Morrowind's own masters. Always load first, in this order, never reorderable. */
const OFFICIAL = ['Morrowind.esm', 'Tribunal.esm', 'Bloodmoon.esm'];
const CONTENT_EXT = /\.(esm|esp|omwaddon|omwgame)$/i;
const ARCHIVE_EXT = /\.(bsa|ba2)$/i;

/**
 * What each content profile expects, for the setup wizard's check.
 *
 * `requires` is the set of named files that must be present. `media` is the set of loose
 * asset directories that must not be empty — and they matter as much as the plugins.
 * Morrowind.bsa carries meshes and textures, but Sound, Music, Video, Fonts and Splash are
 * loose on disk and belong to no archive. Checking only for the .esm and .bsa passes a
 * folder that produces a game with no voice, no music and no intro, and reports it as
 * complete. data/vanilla-manifest.ts learned this the same way and says so.
 */
export const CONTENT_PROFILES: Record<string, {
  label: string; requires: string[]; media: string[]; note: string;
}> = {
  morrowind: {
    label: 'Morrowind',
    requires: ['Morrowind.esm', 'Morrowind.bsa'],
    media: ['Sound', 'Music', 'Video', 'Fonts', 'Splash'],
    note: 'The base game. Copy the WHOLE "Data Files" folder, the plugins and archives are '
      + 'only part of it, and the Sound, Music, Video, Fonts, Splash and BookArt folders sit '
      + 'loose beside them. Without those the game runs, silently and with no intro.',
  },
  expansions: {
    label: 'Morrowind + Tribunal + Bloodmoon',
    requires: [
      'Morrowind.esm', 'Morrowind.bsa',
      'Tribunal.esm', 'Tribunal.bsa',
      'Bloodmoon.esm', 'Bloodmoon.bsa',
    ],
    media: ['Sound', 'Music', 'Video', 'Fonts', 'Splash'],
    note: 'Game of the Year edition. Each expansion needs its .esm AND its .bsa, an .esm '
      + 'without its archive loads and then renders every object as an error marker, which '
      + 'looks like it worked. Copy the whole "Data Files" folder, loose media included.',
  },
  'tamriel-rebuilt': {
    label: 'Tamriel Rebuilt',
    requires: ['Morrowind.esm', 'Morrowind.bsa', 'Tribunal.esm', 'Bloodmoon.esm'],
    media: ['Sound', 'Music', 'Video', 'Fonts', 'Splash'],
    note: 'Game of the Year edition plus the Tamriel Rebuilt landmass. Its own files '
      + '(TR_Mainland.esm, TR_Data.bsa and friends) go in alongside; release names vary, so '
      + 'they are not checked for by name, enable them in the load order once uploaded.',
  },
};

/** Which of a profile's loose media directories actually have files in them. */
function mediaPresent(gameDataDir: string, dirs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of dirs) {
    out[d] = 0;
    try {
      // Case-insensitively: an operator's copy may be "sound" or "Sound" depending on where
      // it came from, and refusing to see one because of its casing would be absurd.
      const actual = readdirSync(gameDataDir)
        .find((e) => e.toLowerCase() === d.toLowerCase());
      if (!actual) continue;
      const full = join(gameDataDir, actual);
      if (!statSync(full).isDirectory()) continue;
      out[d] = countFiles(full);
    } catch { /* absent or unreadable: stays zero */ }
  }
  return out;
}

/** Files anywhere beneath `dir`. Stops counting at a limit — the answer only has to
 *  distinguish "empty" from "has content", and Textures alone runs to thousands. */
function countFiles(dir: string, limit = 50): number {
  let n = 0;
  const stack = [dir];
  while (stack.length && n < limit) {
    const cur = stack.pop()!;
    let ents;
    try { ents = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (n >= limit) break;
      if (e.isDirectory()) stack.push(join(cur, e.name));
      else n++;
    }
  }
  return n;
}

function listFiles(gameDataDir: string): { content: string[]; archives: string[] } {
  if (!existsSync(gameDataDir)) return { content: [], archives: [] };
  let names: string[];
  try {
    if (!statSync(gameDataDir).isDirectory()) return { content: [], archives: [] };
    // Files only. Mods live in gamedata/mods/<slug>/, and a mod folder that happened to be
    // named "Foo.esm" would otherwise be listed as a base-game plugin.
    names = readdirSync(gameDataDir, { withFileTypes: true })
      .filter((e) => !e.isDirectory()).map((e) => e.name);
  } catch {
    return { content: [], archives: [] };
  }
  return {
    content: names.filter((n) => CONTENT_EXT.test(n)),
    archives: names.filter((n) => ARCHIVE_EXT.test(n)),
  };
}

/** The base game's flat load order. Mods are a separate list; see core/mods.ts. */
export function readModlist(dataDir: string): ModEntry[] {
  return readModDoc(dataDir).entries;
}

/**
 * The saved list reconciled against what is actually on disk.
 *
 * Files present but not listed are treated as ENABLED and appended — a file an operator
 * just dropped in must never be silently ignored, because "I added the mod and nothing
 * happened" is an unfalsifiable bug from their side of the screen. They are flagged so the
 * UI can say the list has not been reviewed since.
 */
export function reconcile(gameDataDir: string, dataDir: string): {
  entries: (ModEntry & { official: boolean; isNew: boolean })[];
  missing: string[];
  archives: string[];
} {
  const { content, archives } = listFiles(gameDataDir);
  const onDisk = new Map(content.map((f) => [f.toLowerCase(), f]));
  const saved = readModlist(dataDir);

  const entries: (ModEntry & { official: boolean; isNew: boolean })[] = [];
  const seen = new Set<string>();
  const missing: string[] = [];

  for (const e of saved) {
    const real = onDisk.get(e.file.toLowerCase());
    if (!real) { missing.push(e.file); continue; } // listed but deleted since
    seen.add(real.toLowerCase());
    entries.push({
      file: real,
      enabled: e.enabled,
      official: OFFICIAL.some((o) => o.toLowerCase() === real.toLowerCase()),
      isNew: false,
    });
  }
  const fresh = content
    .filter((f) => !seen.has(f.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  for (const f of fresh) {
    entries.push({
      file: f,
      enabled: true,
      official: OFFICIAL.some((o) => o.toLowerCase() === f.toLowerCase()),
      isNew: saved.length > 0, // on a first-ever read nothing is "new", it is just the list
    });
  }
  return { entries, missing, archives };
}

export function modsView(gameDataDir: string, dataDir: string, profile?: string): unknown {
  const { entries, missing, archives } = reconcile(gameDataDir, dataDir);
  const spec = profile ? CONTENT_PROFILES[profile] : undefined;
  const doc = readModDoc(dataDir);
  return {
    dir: gameDataDir,
    exists: existsSync(gameDataDir),
    entries,
    missing,
    archives,
    profiles: CONTENT_PROFILES,
    // Loose media, counted per directory, so the wizard can say "Music is empty" rather than
    // pronouncing a folder complete because two plugins happen to be present.
    media: spec ? mediaPresent(gameDataDir, spec.media) : undefined,
    // Installed mods, in load order, with `present` telling the page whether the folder is
    // still there — the same courtesy `missing` does for base-game plugins.
    mods: doc.mods.map((m) => ({
      ...m,
      present: existsSync(join(gameDataDir, MODS_SUBDIR, m.slug)),
    })),
    ...(() => {
      const s = resolveMods(doc);
      return { bsaCollisions: s.bsaCollisions, contentCollisions: s.contentCollisions };
    })(),
  };
}

export function saveMods(
  gameDataDir: string,
  dataDir: string,
  incoming: { file?: string; enabled?: boolean }[],
): { ok: true } | { ok: false; error: string } {
  const { content } = listFiles(gameDataDir);
  const onDisk = new Map(content.map((f) => [f.toLowerCase(), f]));

  const entries: ModEntry[] = [];
  const seen = new Set<string>();
  for (const row of incoming) {
    const name = String(row.file ?? '');
    const real = onDisk.get(name.toLowerCase());
    // Refuse names that are not really there. A typo silently accepted would produce a load
    // order referencing a file that never loads, which fails at world start, far from here.
    if (!real) return { ok: false, error: `no such file in the data folder: ${name}` };
    if (seen.has(real.toLowerCase())) return { ok: false, error: `listed twice: ${name}` };
    seen.add(real.toLowerCase());
    entries.push({ file: real, enabled: row.enabled !== false });
  }

  // READ-MODIFY-WRITE, not write. The installed mods live in the same document, and rewriting
  // the whole file from this one field would have deleted every one of them the moment somebody
  // dragged a base-game plugin. writeModDoc keeps the temp-then-rename this used to do itself,
  // and names the same likely causes in its error rather than surfacing a raw ENOENT.
  const doc = readModDoc(dataDir);
  const wrote = writeModDoc(dataDir, { ...doc, entries });
  return wrote.ok ? { ok: true } : { ok: false, error: wrote.error };
}

// --- upload ------------------------------------------------------------------------------
// The onboarding wizard has to be able to receive game data, or a non-technical operator has
// no way to get files onto the server at all — "copy them into the folder" assumes shell
// access to a box that may not be the machine they are sitting at.

// WHAT A REAL DATA FILES FOLDER CONTAINS, which is not just the plugins.
//
// These mirror data/vanilla-manifest.ts exactly, and that file explains why in a comment
// worth repeating: hash a tree that has only the ESMs and "the game installs fine and runs
// with no voice, no music and no intro". Morrowind.bsa carries meshes and textures, but
// Sound, Music, Video, Fonts, Splash and BookArt are LOOSE on disk and belong to nobody's
// archive. An upload path that accepted only .esm/.bsa produced precisely that broken
// install, silently, and called it done.
//
// Kept as two constants rather than one so the split stays visible: core files are loaded by
// NAME from the root, loose media by PATH from its directory.
const CORE_EXT = /\.(esm|esp|bsa|ba2|omwaddon|omwgame)$/i;
const MEDIA_EXT = /\.(mp3|wav|bik|fnt|tex|dds|tga|bmp|zip)$/i;
/** Top-level directories loose media may live under. Anything else is not game data. */
const MEDIA_DIRS = /^(Sound|Music|Video|Fonts|Splash|BookArt|Icons|Textures|Meshes)\//i;
/** Morrowind.bsa alone is ~430 MB and Tamriel Rebuilt ships larger; 8 GB is headroom, not a
 *  target. The point of the cap is that a stuck or hostile client cannot fill the disk. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024;

export type UploadResult = { ok: true; file: string; bytes: number } | { ok: false; status: number; error: string };

/**
 * Accept a client-supplied relative path, or refuse it. Never repairs one.
 *
 * Subdirectories are now allowed, because they have to be: loose media is loaded BY PATH, so
 * "Music/Explore/mx_explore_1.mp3" must land exactly there. The previous version refused any
 * path separator at all, which made a complete Data Files upload impossible.
 *
 * That makes traversal a live concern rather than a theoretical one, so the rule is strict:
 * a path is accepted only if every segment is ordinary, and only if it is either a core file
 * sitting at the root or a media file under one of Morrowind's own asset directories.
 * Anything else is refused outright rather than trimmed into something plausible — a
 * browser sends webkitRelativePath, which is well-formed, so a malformed one is a confused
 * client or a probe and deserves an answer, not a guess.
 */
export function safeUploadPath(raw: string): string | null {
  // Windows clients send backslashes to a Linux server, where they are ordinary characters
  // rather than separators. Normalise first so the checks below see one shape.
  const path = raw.trim().replace(/\\/g, '/');
  if (path === '' || path.length > 400) return null;
  if (path.includes('\0')) return null;
  if (path.startsWith('/')) return null;                  // absolute
  if (/^[a-zA-Z]:/.test(path)) return null;               // drive-relative, e.g. C:foo

  const parts = path.split('/');

  // ANCHOR ON "Data Files" WHEREVER IT APPEARS.
  //
  // The instruction is "drag the Data Files folder", and a good half of the time what gets
  // dragged is the folder ABOVE it: the one called Morrowind, which is what people think of
  // as where the game lives. That arrives as "Morrowind/Data Files/Morrowind.esm", and with
  // only a single leading segment dropped it left "Data Files/Morrowind.esm", which matches
  // neither the core-file rule nor the media rule. Every file was refused, and the page
  // called it "skipped, that is normal for a folder with extras in it" — a total failure
  // reported as expected behaviour.
  //
  // Taking everything after the LAST "Data Files" segment costs nothing in safety: every
  // remaining segment is still validated below, and the final rule still demands a core file
  // at the root or a known media directory. It only means the operator can drop the folder
  // they were most likely to reach for.
  const anchor = parts.map((p) => p.toLowerCase()).lastIndexOf('data files');
  const segments = anchor !== -1
    ? parts.slice(anchor + 1)
    // No "Data Files" anywhere: the browser's directory picker still names the chosen folder
    // as the first segment, so drop one leading container when what remains is recognisable.
    : (parts.length > 1 && !MEDIA_DIRS.test(`${parts[0]}/`) && !CORE_EXT.test(parts[0]!)
      ? parts.slice(1)
      : parts);
  if (segments.length === 0) return null;

  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return null;
    if (seg.startsWith('.')) return null;                 // hidden files and dotdirs
    if (seg.length > 200) return null;
    if (seg !== basename(seg)) return null;               // belt and braces
  }

  const rel = segments.join('/');
  const file = segments[segments.length - 1]!;

  // A core file belongs at the root and nowhere else; media belongs under a known asset
  // directory and nowhere else. Neither can reach anywhere the engine does not read.
  if (segments.length === 1) return CORE_EXT.test(file) ? rel : null;
  return MEDIA_DIRS.test(rel) && MEDIA_EXT.test(file) ? rel : null;
}

/** Can we actually write there? A read-only mount is the likeliest reason and deserves a
 *  readable answer rather than an EACCES the operator has to interpret. */
export function gameDataWritable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stream one content file into the game data folder.
 *
 * Modelled on putBlob in data/fsstorage.ts, including the parts that look redundant and are
 * not: the `over` guard exists because destroy() does not stop already-buffered chunks from
 * arriving, and without it the second handler answers a response that has already been sent
 * and takes the process down.
 */
/** Bumped per request, so two overlapping uploads of one file never share a temp path. */
let uploadSeq = 0;

export async function uploadContent(
  req: IncomingMessage,
  res: ServerResponse,
  gameDataDir: string,
  rawName: string,
): Promise<UploadResult> {
  const name = safeUploadPath(rawName);
  if (!name) {
    return { ok: false, status: 400,
      error: 'That is not part of a Morrowind Data Files folder. Expected a plugin or archive '
        + '(.esm, .esp, .bsa, .omwaddon) at the top level, or media under Sound, Music, Video, '
        + 'Fonts, Splash, BookArt, Icons, Textures or Meshes.' };
  }
  if (!gameDataWritable(gameDataDir)) {
    return { ok: false, status: 409,
      error: 'The game data folder is read-only, so files cannot be uploaded. Copy them in '
        + 'directly, or make the mount writable (remove ":ro" from the gamedata volume).' };
  }

  const target = join(gameDataDir, name);
  // SECOND CHECK, after the path has been resolved. safeUploadPath already refuses anything
  // that could escape, but this is the assertion that actually matters and it costs nothing:
  // whatever we are about to open must be inside the folder we meant.
  const root = gameDataDir.endsWith(sep) ? gameDataDir : gameDataDir + sep;
  if (!resolve(target).startsWith(resolve(root))) {
    log('warn', 'admin.upload_escape_refused', { name: rawName });
    return { ok: false, status: 400, error: 'refused: that path escapes the game data folder' };
  }
  // Media lives in subdirectories, so they have to exist before the stream opens.
  try {
    mkdirSync(dirname(target), { recursive: true });
  } catch (err) {
    log('error', 'admin.upload_mkdir_failed', { name, error: String(err) });
    return { ok: false, status: 500, error: `Could not create the folder for ${name}.` };
  }
  // UNIQUE PER REQUEST, not per process. This was `${target}.${process.pid}.upload`, and in a
  // container the pid is always 1, so every upload of the same file shared one temp path.
  // Two overlapping requests for Morrowind.bsa — a retry started while the first was still
  // in flight, which on a 300MB archive is a long window — wrote into the same file, then the
  // first rename moved it away and the second died with ENOENT. Observed on a real upload.
  //
  // data/fsstorage.ts carries this exact fix and the same explanation; the admin path was
  // written later and did not inherit it.
  const tmp = `${target}.${process.pid}.${uploadSeq++}.upload`;
  const out = createWriteStream(tmp);
  let written = 0;
  let over = false;

  try {
    await new Promise<void>((ok, fail) => {
      req.on('data', (chunk: Buffer) => {
        if (over) return;
        written += chunk.length;
        if (written > MAX_UPLOAD_BYTES) {
          over = true;
          out.destroy();
          req.destroy();
          fail(new Error('over cap'));
          return;
        }
        if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
      });
      req.on('error', fail);
      req.on('end', () => out.end(ok));
      out.on('error', fail);
    });
    // Rename last: a half-received file must never appear in the folder under its real name,
    // because the load-order scan would pick it up and the engine would choke on it.
    //
    // No existsSync-then-unlink first. That was its own race — between the check and the
    // rename another request can put the file back — and it is not needed: rename REPLACES
    // the destination atomically. Windows is the exception, refusing while another handle is
    // open, so that one case unlinks and retries rather than the other way round.
    try {
      renameSync(tmp, target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw err;
      if (existsSync(target)) unlinkSync(target);
      renameSync(tmp, target);
    }
  } catch (err) {
    await rm(tmp, { force: true });
    if (over) {
      log('warn', 'admin.upload_over_cap', { name, written });
      return { ok: false, status: 413, error: 'file is larger than the 8 GB limit' };
    }
    log('error', 'admin.upload_failed', { name, error: String(err) });
    return {
      ok: false,
      status: 500,
      error: `Could not save ${name}. The game data folder may be read-only or out of space.`,
    };
  }

  log('info', 'admin.upload', { file: name, bytes: written });
  return { ok: true, file: name, bytes: written };
}

/**
 * The saved load order for detectGameData, reconciled against the folder.
 *
 * Carries the enabled flag rather than pre-filtering to enabled names only: the engine side
 * has to tell "the operator switched this off" apart from "this arrived after the list was
 * saved", and a bare list of names cannot express the difference. Empty when no list has
 * ever been written, which leaves the historical alphabetical behaviour untouched.
 */
export function orderedContent(gameDataDir: string, dataDir: string): ModEntry[] {
  if (readModlist(dataDir).length === 0) return [];
  return reconcile(gameDataDir, dataDir).entries.map((e) => ({ file: e.file, enabled: e.enabled }));
}
