// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Installed mods: what is on disk, in what order, and what that becomes in openmw.cfg.
//
// A MOD IS A FOLDER, not a pile of files in the game data directory. That is OpenMW's own model
// — each mod is its own `data=` line — and it is the only one in which a mod can be uninstalled,
// reordered, or made to lose a file conflict on purpose. The flat folder this dashboard started
// with can do none of those things.
//
// THE ARRAY IS THE ORDER. There is no `order` field, because two encodings of one fact drift the
// first time a write is interrupted. Later in the array wins a loose-file conflict, which is
// OpenMW's rule for `data=` and therefore the one the operator is really choosing.

import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../log';

/** One plugin a mod provides. Optional .esps are ordinary, so each has its own switch. */
export interface ModPlugin {
  file: string;
  enabled: boolean;
  /** Plugins this one declares as masters, from its TES3 header. Used to warn before a
   *  disable that would abort the engine at startup. */
  masters?: string[];
}

export interface InstalledMod {
  /** Folder name under gamedata/mods, and the id in every API. `[a-z0-9-]{1,64}`. */
  slug: string;
  name: string;
  /** The uploaded archive's filename, so an operator can tell two versions apart. */
  archive: string;
  /** The release the archive's hash was recognised as, when it was one core/tr-releases.ts
   *  knows. Absent for everything else, which is most mods and every unlisted version. */
  release?: string;
  /** Which folder inside that archive was installed. '' = the archive root. */
  source: string;
  installedAt: string;
  enabled: boolean;
  plugins: ModPlugin[];
  archives: string[];
  files: number;
  bytes: number;
}

export interface ModEntry { file: string; enabled: boolean }

/** The whole of modlist.json. `entries` is the BASE game's flat load order, unchanged from v1. */
export interface ModDoc {
  version: 2;
  entries: ModEntry[];
  mods: InstalledMod[];
}

export const MODLIST_FILE = 'modlist.json';
/** Reserved: a mod called "mods" would nest inside its own parent. */
export const MODS_SUBDIR = 'mods';

export const emptyDoc = (): ModDoc => ({ version: 2, entries: [], mods: [] });

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt);

/**
 * Read modlist.json, migrating v1 in memory.
 *
 * v1 was `{entries:[{file,enabled}]}` with no version. It is read as v2 with no mods — the same
 * base-game load order it always described. Nothing is rewritten here: the read path stays
 * read-only, and the first save writes v2.
 *
 * A version from the future is treated as empty rather than parsed optimistically. Mangling a
 * newer file is worse than ignoring it, because the newer writer will be back.
 */
export function readModDoc(dataDir: string): ModDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dataDir, MODLIST_FILE), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log('warn', 'admin.modlist_unreadable', { error: String(err) });
    }
    return emptyDoc();
  }
  const doc = raw as Record<string, unknown>;
  if (doc === null || typeof doc !== 'object') return emptyDoc();

  const version = typeof doc.version === 'number' ? doc.version : 1;
  if (version > 2) {
    log('warn', 'admin.modlist_future_version', { version });
    return emptyDoc();
  }

  const entries: ModEntry[] = Array.isArray(doc.entries)
    ? (doc.entries as Record<string, unknown>[])
      .filter((r) => r !== null && typeof r === 'object' && typeof r.file === 'string')
      .map((r) => ({ file: r.file as string, enabled: r.enabled !== false }))
    : [];

  const mods: InstalledMod[] = version === 2 && Array.isArray(doc.mods)
    ? (doc.mods as Record<string, unknown>[])
      .filter((m) => m !== null && typeof m === 'object' && /^[a-z0-9-]{1,64}$/.test(str(m.slug)))
      .map((m) => ({
        slug: str(m.slug),
        name: str(m.name) || str(m.slug),
        archive: str(m.archive),
        ...(str(m.release) ? { release: str(m.release) } : {}),
        source: str(m.source),
        installedAt: str(m.installedAt),
        enabled: bool(m.enabled, true),
        plugins: Array.isArray(m.plugins)
          ? (m.plugins as Record<string, unknown>[])
            .filter((p) => p !== null && typeof p === 'object' && typeof p.file === 'string')
            .map((p) => ({
              file: p.file as string,
              enabled: p.enabled !== false,
              ...(Array.isArray(p.masters) ? { masters: (p.masters as unknown[]).map(str) } : {}),
            }))
          : [],
        archives: Array.isArray(m.archives) ? (m.archives as unknown[]).map(str).filter(Boolean) : [],
        files: typeof m.files === 'number' ? m.files : 0,
        bytes: typeof m.bytes === 'number' ? m.bytes : 0,
      }))
    : [];

  return { version: 2, entries, mods };
}

/** Write the whole doc. Temp-then-rename, matching how saveMods has always done it. */
export function writeModDoc(dataDir: string, doc: ModDoc): { ok: true } | { ok: false; error: string } {
  const path = join(dataDir, MODLIST_FILE);
  try {
    writeFileSync(`${path}.tmp`, `${JSON.stringify(doc, null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
    return { ok: true };
  } catch (err) {
    log('error', 'admin.modlist_write_failed', { error: String(err) });
    return { ok: false, error: 'Could not save the mod list. The data folder may be read-only or full.' };
  }
}

/**
 * The document with mods whose folder has gone missing dropped.
 *
 * A folder can vanish without the list knowing: an operator tidying gamedata by hand, a bind
 * mount that came up empty, a restore from a backup taken before the install. The dashboard
 * already reports that as `present: false`, but the CONFIG did not care — it went on emitting
 * data= and content= for a mod with no files, and OpenMW aborts at startup on a content file it
 * cannot open. The browser survived this because it verifies what it mounted; the sim peer had
 * no such gate and simply died.
 *
 * Dropped for the purpose of building a config, never deleted from the document: the folder may
 * be back on the next boot, and quietly rewriting the operator's mod list because a disk was
 * slow would be its own bug.
 */
export function presentMods(gameDataDir: string, doc: ModDoc): ModDoc {
  return {
    ...doc,
    mods: doc.mods.filter((m) => {
      try {
        return statSync(join(gameDataDir, MODS_SUBDIR, m.slug)).isDirectory();
      } catch {
        log('warn', 'mods.folder_missing', { slug: m.slug });
        return false;
      }
    }),
  };
}

/** What the enabled mods add to the engine's configuration. */
export interface ModStack {
  /** Relative to the game data dir, in `data=` order. Later wins a loose-file conflict. */
  dataDirs: string[];
  /** Plugin filenames in load order: every mod's masters, then every mod's plugins. */
  content: string[];
  /** Bare archive filenames, in mod order. */
  archives: string[];
  /** Same bare name shipped by more than one mod: OpenMW can only address one of them. */
  bsaCollisions: { name: string; owners: string[] }[];
  /** Same plugin filename from more than one mod. */
  contentCollisions: { file: string; owners: string[] }[];
}

/** `.esm` before `.esp`, which is the order the engine expects and the client also applies. */
export const pluginRank = (f: string): number => (/\.(esm|omwgame)$/i.test(f) ? 0 : 1);

/**
 * Turn the doc into the lines a config needs.
 *
 * A mod that is enabled with every plugin switched off STILL contributes its `data=` line: its
 * meshes and textures are wanted even when its plugin is not. That is the subtle case, and
 * dropping the directory with the plugin would silently un-install half a mod.
 */
export function resolveMods(doc: ModDoc): ModStack {
  const dataDirs: string[] = [];
  const masters: string[] = [];
  const plugins: string[] = [];
  const archives: string[] = [];
  const bsaSeen = new Map<string, string[]>();
  const contentSeen = new Map<string, string[]>();

  for (const m of doc.mods) {
    if (!m.enabled) continue;
    dataDirs.push(`${MODS_SUBDIR}/${m.slug}`);
    for (const a of m.archives) {
      const key = a.toLowerCase();
      const owners = bsaSeen.get(key) ?? [];
      owners.push(m.slug);
      bsaSeen.set(key, owners);
      if (owners.length === 1) archives.push(a);
    }
    for (const p of m.plugins) {
      if (!p.enabled) continue;
      const key = p.file.toLowerCase();
      const owners = contentSeen.get(key) ?? [];
      owners.push(m.slug);
      contentSeen.set(key, owners);
      if (owners.length > 1) continue;
      (pluginRank(p.file) === 0 ? masters : plugins).push(p.file);
    }
  }

  return {
    dataDirs,
    content: [...masters, ...plugins],
    archives,
    bsaCollisions: [...bsaSeen].filter(([, o]) => o.length > 1).map(([name, owners]) => ({ name, owners })),
    contentCollisions: [...contentSeen].filter(([, o]) => o.length > 1).map(([file, owners]) => ({ file, owners })),
  };
}
