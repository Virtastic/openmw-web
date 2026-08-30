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

import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
    return { ok: false, error: `could not write ${MODLIST_FILE}: ${String(err)}` };
  }
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
