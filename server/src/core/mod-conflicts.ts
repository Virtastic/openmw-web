// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Which mods step on each other, and which ones need each other.
//
// Two different questions with two different consequences.
//
// FILE CONFLICTS are normal and often intended: a texture replacer exists to overwrite the base
// game's textures, and two of them overlapping is the operator's call, not an error. OpenMW
// already has an answer — the last data= dir wins — so the job here is to SHOW that answer,
// not to prevent it. "12 files also in Better Bodies; this one wins" turns an invisible rule
// into a visible one.
//
// MISSING MASTERS are not survivable. A plugin whose master is absent aborts the engine at
// startup, which reaches the player as a black screen. That one has to be caught before the
// save, and again in the browser as a backstop.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MODS_SUBDIR, type ModDoc } from './mods';

/** Where commitInstall parks each mod's file list. */
export const MOD_META = 'mod-files';

export interface Conflict {
  /** The mod that wins, i.e. the one latest in the list. */
  winner: string;
  /** The mod that loses to it. */
  loser: string;
  files: number;
  /** A handful, for the UI. The full list is not worth sending: Tamriel Rebuilt is 40,000. */
  sample: string[];
}

export interface MissingMaster {
  mod: string;
  plugin: string;
  master: string;
}

/**
 * Cached per file, keyed on its mtime.
 *
 * The dashboard polls, and a mod's file list is written once and then never changes until it is
 * uninstalled. Tamriel Rebuilt is around 40,000 paths; re-reading and re-lowercasing that on
 * every poll, for every installed mod, is megabytes of JSON parsing to answer a question whose
 * inputs did not move.
 */
const fileCache = new Map<string, { at: number; files: Set<string> }>();

const filesOf = (dataDir: string, slug: string): Set<string> => {
  const path = join(dataDir, MOD_META, `${slug}.json`);
  let at = 0;
  try { at = statSync(path).mtimeMs; } catch { return new Set(); }
  const hit = fileCache.get(path);
  if (hit && hit.at === at) return hit.files;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const files = new Set(Array.isArray(raw) ? raw.map((f) => String(f).toLowerCase()) : []);
    fileCache.set(path, { at, files });
    return files;
  } catch {
    return new Set(); // installed before file lists existed, or the list is gone
  }
};

/**
 * Every pair of enabled mods that provide the same file.
 *
 * Pairwise rather than a flat "these files are contested" list, because the useful sentence is
 * about two named mods. The winner is whichever comes LATER in doc.mods, which is exactly what
 * OpenMW does with the data= lines built from that same order.
 */
export function computeConflicts(dataDir: string, doc: ModDoc): Conflict[] {
  const enabled = doc.mods.filter((m) => m.enabled);
  if (enabled.length < 2) return [];

  const lists = new Map(enabled.map((m) => [m.slug, filesOf(dataDir, m.slug)]));
  const out: Conflict[] = [];

  for (let i = 0; i < enabled.length; i++) {
    for (let j = i + 1; j < enabled.length; j++) {
      const earlier = enabled[i]!.slug;
      const later = enabled[j]!.slug;
      const a = lists.get(earlier)!;
      const b = lists.get(later)!;
      if (a.size === 0 || b.size === 0) continue;
      const shared: string[] = [];
      // Walk the smaller set: a big mod against a small one should cost the small one.
      const [small, big] = a.size <= b.size ? [a, b] : [b, a];
      for (const f of small) if (big.has(f)) shared.push(f);
      if (shared.length === 0) continue;
      shared.sort();
      out.push({ winner: later, loser: earlier, files: shared.length, sample: shared.slice(0, 8) });
    }
  }
  return out;
}

/**
 * Plugins whose masters are not going to be loaded.
 *
 * `baseContent` is what the base game contributes (Morrowind.esm and any enabled expansion),
 * because most mod masters are exactly those. Comparison is case-insensitive: Morrowind's own
 * filenames vary in case between installs and a plugin's header records whatever it was built
 * against.
 */
export function missingMasters(doc: ModDoc, baseContent: string[]): MissingMaster[] {
  const available = new Set(baseContent.map((f) => f.toLowerCase()));
  for (const m of doc.mods) {
    if (!m.enabled) continue;
    for (const p of m.plugins) if (p.enabled) available.add(p.file.toLowerCase());
  }

  const out: MissingMaster[] = [];
  for (const m of doc.mods) {
    if (!m.enabled) continue;
    for (const p of m.plugins) {
      if (!p.enabled) continue;
      for (const need of p.masters ?? []) {
        if (!available.has(need.toLowerCase())) out.push({ mod: m.slug, plugin: p.file, master: need });
      }
    }
  }
  return out;
}

/** Where a mod's files live, for anything that needs to read them back. */
export const modRoot = (gameDataDir: string, slug: string): string =>
  join(gameDataDir, MODS_SUBDIR, slug);
