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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { log } from '../log';

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

/**
 * settings.cfg for the sim peer. WITHOUT THIS THE PEER EATS A WHOLE CORE: it renders headless,
 * so nothing paces its main loop — no vsync, and OpenMW's default `framerate limit = 0` means
 * unlimited — and it spins as fast as the CPU allows. Measured at 96-97% of a core each, which
 * on a machine also running the player's browser is felt directly as movement lag: the server's
 * 15 Hz broadcast tick cannot keep time when the box is saturated.
 *
 * 20 fps is deliberate. The peer exists to simulate NPCs and hold cell authority, and the wire
 * carries poses at 15 Hz, so anything above the broadcast rate is work nobody can observe.
 */
export function buildPeerSettings(): string {
  return [
    '# GENERATED by openmw-mp for the Phase H simulation peer. Edits are overwritten.',
    '[Video]',
    // THE ACTOR STREAM RATE. The peer broadcasts NPC positions once per frame (actors.lua),
    // so this number is the rate players receive them at — it is not just a CPU knob. 20 is
    // the balance point: below it the client interpolator runs short of snapshots to blend
    // between, above it costs cycles nobody can perceive (the server re-batches at 15 Hz).
    'framerate limit = 20',
    'vsync mode = 0',
    '[Shadows]',
    'enable shadows = false',
    '[Water]',
    'shader = false',
    // Preloading warms caches for cells the player is ABOUT to walk into. The peer does not
    // walk anywhere — it is parked on its cluster anchor — so every preloaded cell is memory
    // held for a visit that never happens, on a background thread that costs CPU to run.
    '[Cells]',
    'preload enabled = false',
    // The world map is a rendered image nobody looks at: this peer has no UI. 18px per
    // exterior cell across Vvardenfell is a several-megabyte RGBA surface built at startup.
    // 1 is the floor the setting accepts, not a disable, but it takes the cost to ~nothing.
    '[Map]',
    'global map cell size = 1',
    '',
  ].join('\n');
}

/** Conventional location: <dataDir>/gamedata — the operator drops their files here. */
/**
 * Resolve the sim-peer binary. An explicit [simPeer] binary always wins; an empty value
 * probes the conventional install locations (the tier2 image puts it at /usr/local/bin).
 * Returns '' when nothing is found — the caller logs the tier either way.
 */
export function findPeerBinary(configured: string, probe: (p: string) => boolean = existsSync): string {
  if (configured) return configured;
  for (const p of ['/usr/local/bin/openmw', '/usr/bin/openmw', '/opt/openmw/bin/openmw']) {
    if (probe(p)) return p;
  }
  return '';
}

export function gameDataDir(dataDir: string): string {
  return join(dataDir, 'gamedata');
}

/**
 * sha256 per CONTENT file, for `[content] enforce = "strict"`.
 *
 * ARCHIVES ARE DELIBERATELY NOT HASHED. Measured in play/mwdata: content files total ~90 MB
 * (Morrowind 76.1 + Tribunal 4.3 + Bloodmoon 9.2) against ~471 MB of BSAs. Gameplay records —
 * items, stats, NPCs, spells, everything worth cheating with — live in the content files;
 * BSAs hold meshes, textures and sounds, so tampering there changes what a player SEES, not
 * the balance. Hashing them would be ~7x the cost for little security value, and far worse in
 * the browser: the client streams archives on demand via range reads, so hashing one would
 * force a full download of a file it otherwise never reads end to end. Content files are
 * already read in full at load, so hashing them costs no extra I/O.
 *
 * Returns a name -> sha256 map. Unreadable files are omitted rather than throwing: a hash we
 * could not compute must not become a refusal for every player.
 */
export function hashContentFiles(data: GameData): Map<string, string> {
  const out = new Map<string, string>();
  if (!data.ok) return out;
  for (const name of data.contentFiles) {
    try {
      const buf = readFileSync(join(data.dir, name));
      out.set(name, createHash('sha256').update(buf).digest('hex'));
    } catch (err) {
      log('warn', 'gamedata.hash_failed', { file: name, error: String(err) });
    }
  }
  return out;
}
