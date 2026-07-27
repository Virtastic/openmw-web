// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Tier detection: does this server have usable game data of its own?
//
// THE RELAY SERVER NEEDS NO GAME DATA. Multiplayer — movement, chat, objects, quests, combat,
// friends — works with an empty folder, and always has. Game data buys ONE thing: the sim
// peer (Phase H), which simulates NPCs on the operator's machine instead of in a player's
// browser. So an empty folder degrades to "NPCs simulated by a player's client", never to
// "no multiplayer".
//
//   tier 1  no/invalid game data  -> full multiplayer, client-authority NPCs
//   tier 2  valid game data       -> tier 1 + a sim peer holds the cells
//
// This module ONLY validates and reports. It deliberately does NOT build a content manifest:
// a real client's list starts `builtin.omwscripts`, `openmw-template.omwgame` — both from the
// ENGINE's resources, not from any data folder — so no directory scan can reproduce it. The
// authoritative manifest comes from the sim peer itself (see ContentGate.setAuthoritative).

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface GameData {
  ok: boolean;
  dir: string;
  /** Content files present, official masters first then mods — for the generated peer cfg. */
  contentFiles: string[];
  /** Archives present, for the peer's fallback-archive lines. Never part of a manifest. */
  archives: string[];
  /** What a partial drop lacks. Non-empty implies !ok. */
  missing: string[];
  /** Human-readable, logged verbatim at boot so a degrade is never silent. */
  reason: string;
}

// Morrowind's three official masters and the archive each one needs. An .esm without its .bsa
// loads, then renders and simulates `marker_error` for everything — observed directly during
// the Phase H spike. That is strictly worse than an empty folder, because it looks like it
// works. Hence pairing is REQUIRED, not advisory.
const OFFICIAL: readonly { esm: string; bsa: string }[] = [
  { esm: 'Morrowind.esm', bsa: 'Morrowind.bsa' },
  { esm: 'Tribunal.esm', bsa: 'Tribunal.bsa' },
  { esm: 'Bloodmoon.esm', bsa: 'Bloodmoon.bsa' },
];

const CONTENT_EXT = /\.(esm|esp|omwaddon|omwgame)$/i;
const ARCHIVE_EXT = /\.bsa$/i;

/**
 * Inspect `dir` and decide whether a sim peer could actually run against it.
 * Never throws: an unreadable or absent folder is simply tier 1.
 */
export function detectGameData(dir: string): GameData {
  const none = (reason: string): GameData => ({
    ok: false, dir, contentFiles: [], archives: [], missing: [], reason,
  });

  if (!existsSync(dir)) return none(`no game data directory at ${dir}`);
  let names: string[];
  try {
    if (!statSync(dir).isDirectory()) return none(`${dir} is not a directory`);
    names = readdirSync(dir);
  } catch (err) {
    return none(`cannot read ${dir}: ${String(err)}`);
  }
  if (names.length === 0) return none(`game data directory ${dir} is empty`);

  // Case-insensitive lookup: operators copy from Windows installs, and the on-disk casing of
  // "Morrowind.esm" varies. Keep the real name for the cfg we generate.
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const has = (n: string): string | undefined => byLower.get(n.toLowerCase());

  if (!has('Morrowind.esm')) {
    return none(`no Morrowind.esm in ${dir} — the sim peer needs game data to simulate`);
  }

  // Pair each PRESENT official master with its archive.
  const missing: string[] = [];
  const contentFiles: string[] = [];
  for (const { esm, bsa } of OFFICIAL) {
    const foundEsm = has(esm);
    if (!foundEsm) continue;
    if (!has(bsa)) missing.push(bsa);
    contentFiles.push(foundEsm);
  }
  if (missing.length) {
    return {
      ok: false, dir, contentFiles: [], archives: [], missing,
      reason: `game data in ${dir} is incomplete — missing ${missing.join(', ')}`
        + ' (an .esm without its .bsa simulates a broken world, so this is refused)',
    };
  }

  // Mods after the official masters: .esm as masters, then .esp plugins, each alphabetical.
  // Mirrors the browser client's ordering (play/index.html) so a generated cfg and a player's
  // client agree; the AUTHORITATIVE list still comes from the peer, not from here.
  const officialLower = new Set(
    OFFICIAL.flatMap(({ esm, bsa }) => [esm.toLowerCase(), bsa.toLowerCase()]));
  const byName = (a: string, b: string): number =>
    (a.toLowerCase() < b.toLowerCase() ? -1 : 1);
  const modEsm: string[] = [];
  const modEsp: string[] = [];
  const archives: string[] = [];
  for (const n of names) {
    const lower = n.toLowerCase();
    if (ARCHIVE_EXT.test(lower)) { archives.push(n); continue; }
    if (officialLower.has(lower) || !CONTENT_EXT.test(lower)) continue;
    if (/\.esm$/i.test(lower)) modEsm.push(n);
    else modEsp.push(n);
  }
  modEsm.sort(byName);
  modEsp.sort(byName);
  archives.sort(byName);

  const all = [...contentFiles, ...modEsm, ...modEsp];
  const mods = modEsm.length + modEsp.length;
  return {
    ok: true, dir, contentFiles: all, archives, missing: [],
    reason: `game data ok: ${all.join(', ')}`
      + (mods > 0 ? ` (${mods} mod plugin(s))` : ''),
  };
}

/**
 * The openmw.cfg a sim peer needs for this data. Modelled on the config proven to work in the
 * Phase H spike (data= / content= in order / fallback-archive= per BSA / resources=).
 *
 * KNOWN LIMITATION, deliberately not hidden: a generated cfg has none of the several hundred
 * `fallback=` entries that openmw-iniimporter derives from Morrowind.ini. The spike booted and
 * simulated Seyda Neen without them, so core simulation is fine, but weather and some GMST-
 * adjacent behaviour may differ from a full desktop install.
 */
export function buildPeerCfg(data: GameData, resourcesDir: string): string {
  const lines = [
    '# GENERATED by openmw-mp for the Phase H simulation peer. Edits are overwritten.',
    `data=${data.dir}`,
    ...data.contentFiles.map((c) => `content=${c}`),
    // Last, matching where the browser client appends it.
    'content=mp.omwscripts',
    ...data.archives.map((a) => `fallback-archive=${a}`),
    `resources=${resourcesDir}`,
  ];
  return lines.join('\n') + '\n';
}

/** Conventional location: <dataDir>/gamedata — the operator drops their files here. */
export function gameDataDir(dataDir: string): string {
  return join(dataDir, 'gamedata');
}
