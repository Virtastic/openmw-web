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

/** sha256 of the archive as published -> the version to show. */
export const TR_RELEASES: Record<string, string> = {
  // '…64 lowercase hex chars…': 'Tamriel Rebuilt 24.10',
};

/** The release this archive is, or null for one this table has never been told about. */
export function identifyRelease(sha256: string): string | null {
  return TR_RELEASES[String(sha256).trim().toLowerCase()] ?? null;
}

/**
 * Does this archive plausibly contain Tamriel Rebuilt at all?
 *
 * A weak check on purpose, and separate from the hash: it exists to catch the operator who
 * dropped the wrong download onto the TR step, not to police versions. Every TR release ships
 * its plugins and archives under the TR_ prefix, and has since the mod was called that.
 */
const TR_FILE = /(^|\/)TR_[^/]*\.(esm|esp|omwaddon|bsa)$/i;
export function looksLikeTamrielRebuilt(paths: string[]): boolean {
  return paths.some((p) => TR_FILE.test(p));
}
