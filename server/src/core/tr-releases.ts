// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Which Tamriel Rebuilt release an uploaded archive is, decided by the hash of the archive.
//
// NOTHING ELSE IDENTIFIES IT. api-mods.ts checks the base game by filename and says, in the
// tamriel-rebuilt profile itself, that TR's own files are "not checked for by name" because
// release names vary — the download is TR_Assets and TR_Mainland in one release and a single
// dated zip in the next, and the plugin names change across major versions too. The bytes do
// not vary: one release is one archive is one sha256.
//
// AN UNKNOWN HASH IS NOT AN ERROR. A release newer than this table (the usual case, since TR
// ships on its own schedule) or an older one nobody recorded installs exactly the same way.
// The table only decides whether a version number can be put on screen next to it. Anything
// that made an unrecognised hash refuse the install would turn a stale table into an outage.
//
// TO ADD A RELEASE: run `sha256sum` over the archive as downloaded, unmodified — the wizard
// also prints the hash of whatever was just uploaded, which is the easier way to get it — and
// add the line here. Lowercase hex, keyed by hash because that is what the lookup has.

/**
 * sha256 of the archive as published -> the version to show.
 *
 * BOTH HALVES LIVE HERE. A working install is two downloads — the landmass and the assets it
 * draws from — published separately, versioned separately, and hashed separately.
 */
export const TR_RELEASES: Record<string, string> = {
  // The landmass. 68,039,458 bytes; holds 00 Core (TR_Mainland.esm), 01 Faction Integration
  // and 02 Firemoth Remover.
  '0613f33fabcc9285d821f52524ab4c2d2bece37dcdc1eb110ada772dd0ca73ef': 'Tamriel Rebuilt 26.08.23',
  // The assets, in two editions of the same release. 54,369 files apiece; the HD one expands
  // to 6.9GB against the standard one's 2.7GB, which is the whole difference between them.
  '009530c0383759b842298e827bf1ffd88e29b68668bbefe794bc376713e821cf': 'Tamriel Data 26.08',
  'da5b37375434c265c47f484c4f005cf7e279bcaa1cccc39bf56c92d5bf8f5cda': 'Tamriel Data 26.08 (HD)',
};

/** The release this archive is, or null for one this table has never been told about. */
export function identifyRelease(sha256: string): string | null {
  return TR_RELEASES[String(sha256).trim().toLowerCase()] ?? null;
}

/**
 * Does this archive plausibly belong to a Tamriel Rebuilt install at all?
 *
 * A weak check on purpose, and separate from the hash: it exists to catch the operator who
 * dropped the wrong download onto the TR step, not to police versions.
 *
 * BOTH NAMING SCHEMES, because the two halves do not share one. The landmass ships TR_-prefixed
 * plugins; Tamriel Data ships Tamriel_Data.esm and its assets LOOSE rather than in a .bsa, so a
 * TR_ prefix appears nowhere in it. Checked against the real 26.08 downloads: the first version
 * of this told an operator uploading the correct Tamriel Data archive that it did not look like
 * Tamriel Rebuilt.
 */
const TR_FILE = /(^|\/)(TR_[^/]*|Tamriel_Data)\.(esm|esp|omwaddon|bsa)$/i;
export function looksLikeTamrielRebuilt(paths: string[]): boolean {
  return paths.some((p) => TR_FILE.test(p));
}
