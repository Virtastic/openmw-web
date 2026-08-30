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
import { join, basename } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '../../log';

export const MODLIST_FILE = 'modlist.json';

export interface ModEntry {
  file: string;
  enabled: boolean;
}

/** Morrowind's own masters. Always load first, in this order, never reorderable. */
const OFFICIAL = ['Morrowind.esm', 'Tribunal.esm', 'Bloodmoon.esm'];
const CONTENT_EXT = /\.(esm|esp|omwaddon|omwgame)$/i;
const ARCHIVE_EXT = /\.(bsa|ba2)$/i;

/** What each content profile expects to find, for the setup wizard's file check. */
export const CONTENT_PROFILES: Record<string, { label: string; requires: string[]; note: string }> = {
  morrowind: {
    label: 'Morrowind',
    requires: ['Morrowind.esm', 'Morrowind.bsa'],
    note: 'The base game only.',
  },
  expansions: {
    label: 'Morrowind + Tribunal + Bloodmoon',
    requires: ['Morrowind.esm', 'Morrowind.bsa', 'Tribunal.esm', 'Tribunal.bsa', 'Bloodmoon.esm', 'Bloodmoon.bsa'],
    note: 'Game of the Year edition. Each expansion needs its .esm AND its .bsa — an .esm ' +
      'without its archive loads and then renders every object as an error marker, which ' +
      'looks like it worked.',
  },
  'tamriel-rebuilt': {
    label: 'Tamriel Rebuilt',
    requires: ['Morrowind.esm', 'Morrowind.bsa', 'Tribunal.esm', 'Bloodmoon.esm'],
    note: 'Tamriel Rebuilt needs the Game of the Year files plus its own TR_Mainland.esm and ' +
      'TR_Data.bsa. Add those in the mod list once uploaded — file names vary by release, so ' +
      'they are not checked automatically.',
  },
};

function listFiles(gameDataDir: string): { content: string[]; archives: string[] } {
  if (!existsSync(gameDataDir)) return { content: [], archives: [] };
  let names: string[];
  try {
    if (!statSync(gameDataDir).isDirectory()) return { content: [], archives: [] };
    names = readdirSync(gameDataDir);
  } catch {
    return { content: [], archives: [] };
  }
  return {
    content: names.filter((n) => CONTENT_EXT.test(n)),
    archives: names.filter((n) => ARCHIVE_EXT.test(n)),
  };
}

export function readModlist(dataDir: string): ModEntry[] {
  const path = join(dataDir, MODLIST_FILE);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries.flatMap((e) => {
      const row = e as { file?: unknown; enabled?: unknown };
      return typeof row.file === 'string' ? [{ file: row.file, enabled: row.enabled !== false }] : [];
    });
  } catch (err) {
    log('warn', 'admin.modlist_unreadable', { error: String(err) });
    return [];
  }
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

export function modsView(gameDataDir: string, dataDir: string): unknown {
  const { entries, missing, archives } = reconcile(gameDataDir, dataDir);
  return {
    dir: gameDataDir,
    exists: existsSync(gameDataDir),
    entries,
    missing,
    archives,
    profiles: CONTENT_PROFILES,
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

  const path = join(dataDir, MODLIST_FILE);
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ entries }, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
    return { ok: true };
  } catch (err) {
    // A raw ENOENT/EACCES in a toast tells the reader nothing they can act on. Name the
    // likely cause instead, and keep the detail in the log where it is useful.
    log('error', 'admin.modlist_write_failed', { error: String(err) });
    return {
      ok: false,
      error: 'Could not save the load order. The data folder may be read-only or full.',
    };
  }
}

// --- upload ------------------------------------------------------------------------------
// The onboarding wizard has to be able to receive game data, or a non-technical operator has
// no way to get files onto the server at all — "copy them into the folder" assumes shell
// access to a box that may not be the machine they are sitting at.

/** What may be written into the game data folder. Nothing else, ever. */
const UPLOAD_EXT = /\.(esm|esp|bsa|ba2|omwaddon|omwgame)$/i;
/** Morrowind.bsa alone is ~430 MB and Tamriel Rebuilt ships larger; 8 GB is headroom, not a
 *  target. The point of the cap is that a stuck or hostile client cannot fill the disk. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024;

export type UploadResult = { ok: true; file: string; bytes: number } | { ok: false; status: number; error: string };

/**
 * Accept a client-supplied filename, or refuse it. Never repairs one.
 *
 * REFUSE, don't sanitise. Running basename() over "../../owned.esp" yields "owned.esp",
 * which is safe — nothing escapes the folder — but it silently writes a file the operator
 * never named, under a name they did not choose. A browser's File.name never contains a
 * path separator, so anything that does is a confused client or a probe, and both are
 * better served by a clear refusal than by a quiet rename.
 *
 * Both separators are checked, not just the platform's: a Windows client can send a
 * backslash to a Linux server, where basename() would not treat it as one.
 */
export function safeUploadName(raw: string): string | null {
  const name = raw.trim();
  if (name === '' || name.length > 200) return null;
  if (name.includes('/') || name.includes('\\')) return null;
  if (name.includes('\0')) return null;
  if (name.startsWith('.')) return null;      // hidden files, and "..'
  if (name !== basename(name)) return null;   // belt and braces: anything path-like at all
  if (!UPLOAD_EXT.test(name)) return null;
  return name;
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
export async function uploadContent(
  req: IncomingMessage,
  res: ServerResponse,
  gameDataDir: string,
  rawName: string,
): Promise<UploadResult> {
  const name = safeUploadName(rawName);
  if (!name) {
    return { ok: false, status: 400,
      error: 'that is not a game data file — expected .esm, .esp, .bsa, .omwaddon or .omwgame' };
  }
  if (!gameDataWritable(gameDataDir)) {
    return { ok: false, status: 409,
      error: 'the game data folder is read-only, so files cannot be uploaded. Copy them in '
        + 'directly, or make the mount writable (remove ":ro" from the gamedata volume).' };
  }

  const target = join(gameDataDir, name);
  const tmp = `${target}.${process.pid}.upload`;
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
    if (existsSync(target)) unlinkSync(target);
    renameSync(tmp, target);
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
