// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// One-click update of the game client bundle (play/, mounted at /client).
//
// The engine is a ~330MB build artifact that lives in GitHub Releases, not in git, so
// updating it is a download problem, not a deploy problem: fetch the release zip, verify it
// against the release's own SHA256SUMS, unpack, and swap the files the bind mount is
// serving. No restart — the folder is read live.
//
// The swap is the part engineered for failure. Extraction goes to a staging directory
// INSIDE the client dir (a rename from /data would be a cross-mount EXDEV), nothing live is
// touched until staging holds a plausible bundle, files move one rename at a time (a whole
// directory rename dies with ENOTEMPTY on the second update), and index.html — the file
// that points at the new engine — moves DEAD LAST. A crash anywhere leaves the old index
// pointing at the old engine, which is still fully present.

import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

import { log } from '../../log';
import { extractEntry, listEntries, normaliseEntryPath, ZipError } from '../../core/zip';
import { streamToFile, trackProgress } from './mod-install';

export interface EngineDeps { clientDir: string; dataDir: string }

const RELEASES_URL = 'https://api.github.com/repos/Virtastic/openmw-web/releases/latest';
/** The engine zip is ~350MB today; 2GB is headroom against a hostile redirect, not a plan. */
const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024;

/** What the dashboard needs to render the engine card. */
export function engineStatus(clientDir: string): { writable: boolean; tag: string | null; present: boolean } {
  let writable = false;
  try {
    // A real write, not accessSync: access checks lie on bind mounts, where the only
    // truthful probe is doing the thing.
    const probe = join(clientDir, '.write-probe');
    writeFileSync(probe, '');
    unlinkSync(probe);
    writable = true;
  } catch { /* not writable, or not there at all */ }
  let tag: string | null = null;
  try {
    const t = readFileSync(join(clientDir, '.release-tag'), 'utf8').trim();
    if (/^v[0-9A-Za-z.\-]{1,32}$/.test(t)) tag = t;
  } catch { /* never updated from here: unknown, which the UI says honestly */ }
  const present = existsSync(join(clientDir, 'index.html'));
  return { writable, tag, present };
}

/** Resolve the newest release and its two assets. Shapes only; nothing is downloaded. */
export async function resolveLatestRelease(): Promise<
  { ok: true; tag: string; zipUrl: string; sumsUrl: string } | { ok: false; error: string }> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(RELEASES_URL, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'openmw-web-dashboard' },
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return { ok: false, error: `GitHub answered ${r.status}` };
    const rel = await r.json() as {
      tag_name?: string; assets?: { name?: string; browser_download_url?: string }[];
    };
    const tag = String(rel.tag_name ?? '');
    if (!/^v[0-9A-Za-z.\-]{1,32}$/.test(tag)) return { ok: false, error: 'release has no usable tag' };
    const asset = (name: string) =>
      rel.assets?.find((a) => a.name === name)?.browser_download_url ?? '';
    const zipUrl = asset(`openmw-web-${tag}.zip`);
    const sumsUrl = asset('SHA256SUMS');
    if (!zipUrl || !sumsUrl) {
      return { ok: false, error: `release ${tag} is missing its bundle or checksums (it may still be building)` };
    }
    return { ok: true, tag, zipUrl, sumsUrl };
  } catch {
    return { ok: false, error: 'could not reach GitHub' };
  }
}

/** The sha256 SHA256SUMS declares for one file, or null. `shasum -a 256` line format. */
export function shaFor(sums: string, filename: string): string | null {
  for (const line of sums.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (m && m[2] === filename) return m[1]!;
  }
  return null;
}

/**
 * Extraction and swap, network-free — the unit-tested core.
 *
 * Guarantees: nothing live changes until staging holds index.html and an engine; nothing
 * outside the client dir is ever written (normaliseEntryPath refuses traversal and the
 * resolved path is checked again); a failure at any point leaves the served client exactly
 * as it was, because index.html is the last file to move.
 */
export async function installEngineZip(
  zipPath: string,
  clientDir: string,
  tag: string,
  progress: (pct: number, note: string) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const staging = join(clientDir, '.staging');
  try {
    await rm(staging, { recursive: true, force: true }); // a previous crash's leftovers
    mkdirSync(staging, { recursive: true });

    const entries = listEntries(zipPath).filter((e) => !e.isDir);
    let done = 0;
    for (const e of entries) {
      const rel = normaliseEntryPath(e.path);
      if (rel === null) continue; // traversal or junk name: skipped, never repaired
      const dest = resolve(staging, rel);
      if (!dest.startsWith(resolve(staging) + sep)) continue; // belt over the same braces
      mkdirSync(dirname(dest), { recursive: true });
      await extractEntry(zipPath, e, dest);
      done++;
      if (done % 20 === 0) progress(60 + Math.round((30 * done) / entries.length), 'unpacking the release');
    }

    // The gate that makes a truncated or wrong zip a NO-OP: a client bundle has an
    // index.html and a content-hashed engine dir. Anything else must not touch live files.
    const eDir = join(staging, 'e');
    const hashes = existsSync(eDir)
      ? readdirSync(eDir).filter((n) => /^[0-9a-f]{12}$/.test(n)
        && existsSync(join(eDir, n, 'openmw.wasm')))
      : [];
    if (!existsSync(join(staging, 'index.html')) || hashes.length === 0) {
      await rm(staging, { recursive: true, force: true });
      return { ok: false, error: 'that release did not look like a client bundle; nothing was changed' };
    }

    // Keep-set BEFORE the swap: whatever engine dirs exist now survive this update, so the
    // page a player already has open keeps working. Dirs orphaned by EARLIER updates go.
    const liveE = join(clientDir, 'e');
    const keep = new Set(existsSync(liveE) ? readdirSync(liveE) : []);
    for (const h of hashes) keep.add(h);

    // The swap: per-file renames (same volume, atomic-over-existing), index.html dead last.
    progress(92, 'installing');
    const moves: { from: string; to: string }[] = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const from = join(dir, ent.name);
        if (ent.isDirectory()) { walk(from); continue; }
        moves.push({ from, to: join(clientDir, from.slice(staging.length + 1)) });
      }
    };
    walk(staging);
    moves.sort((a, b) => Number(a.to === join(clientDir, 'index.html')) - Number(b.to === join(clientDir, 'index.html')));
    for (const m of moves) {
      mkdirSync(dirname(m.to), { recursive: true });
      try {
        renameSync(m.from, m.to);
      } catch {
        // A host-side process holding the file (Windows bind mounts): clear and retry once.
        await rm(m.to, { force: true });
        renameSync(m.from, m.to);
      }
    }

    writeFileSync(join(clientDir, '.release-tag'), `${tag}\n`);
    await rm(staging, { recursive: true, force: true });

    // Prune engines no live page can be using: everything not in the keep-set captured
    // above. First update prunes nothing; the one after removes the pre-first engine.
    // Cleanup failure must never fail a successful update.
    try {
      for (const n of readdirSync(liveE)) {
        if (!keep.has(n)) await rm(join(liveE, n), { recursive: true, force: true });
      }
    } catch (e) { log('warn', 'update.engine_prune_failed', { error: String(e) }); }

    return { ok: true };
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    return {
      ok: false,
      error: e instanceof ZipError ? e.message : `could not install the release: ${String(e)}`,
    };
  }
}

/** The whole job, detached. Reports through the shared progress map; see startEngineUpdate. */
async function updateEngine(
  deps: EngineDeps,
  progress: (pct: number, note: string) => void,
): Promise<{ ok: true; tag: string } | { ok: false; error: string }> {
  progress(0, 'finding the latest release');
  const rel = await resolveLatestRelease();
  if (!rel.ok) return rel;
  const current = engineStatus(deps.clientDir).tag;
  if (current === rel.tag) return { ok: false, error: `already on ${rel.tag}` };

  let sums = '';
  try {
    const r = await fetch(rel.sumsUrl, { headers: { 'user-agent': 'openmw-web-dashboard' } });
    if (!r.ok) return { ok: false, error: `checksums download failed (${r.status})` };
    sums = await r.text();
  } catch { return { ok: false, error: 'checksums download failed' }; }
  const want = shaFor(sums, `openmw-web-${rel.tag}.zip`);
  if (!want) return { ok: false, error: 'the release checksums do not list its own bundle' };

  // Into the existing mod staging dir, whose TTL sweep already cleans up crashed downloads.
  const zipPath = join(deps.dataDir, 'mod-staging', `engine-${randomBytes(8).toString('hex')}.zip`);
  try {
    const r = await fetch(rel.zipUrl, { headers: { 'user-agent': 'openmw-web-dashboard' } });
    if (!r.ok || !r.body) return { ok: false, error: `download failed (${r.status})` };
    const total = Number(r.headers.get('content-length')) || 0;
    // streamToFile reports nothing mid-stream; watching the file grow costs nothing and
    // keeps the shared helper untouched.
    const watcher = setInterval(() => {
      try {
        const b = statSync(zipPath).size;
        progress(total ? Math.min(59, 2 + Math.round((57 * b) / total)) : 20,
          `downloading ${rel.tag} (${Math.round(b / 1048576)} MB)`);
      } catch { /* not created yet */ }
    }, 500);
    let got;
    try {
      got = await streamToFile(Readable.from(r.body as unknown as AsyncIterable<Uint8Array>), zipPath, MAX_ZIP_BYTES);
    } finally { clearInterval(watcher); }
    if (!got.ok) return { ok: false, error: got.over ? 'the download exceeded the size limit' : 'the download did not finish' };
    if (got.sha256 !== want) {
      return { ok: false, error: 'checksum mismatch — the download was corrupted; try again' };
    }
    progress(60, 'unpacking the release');
    const inst = await installEngineZip(zipPath, deps.clientDir, rel.tag, progress);
    if (!inst.ok) return inst;
    log('info', 'update.engine_installed', { tag: rel.tag });
    return { ok: true, tag: rel.tag };
  } finally {
    await rm(zipPath, { force: true });
  }
}

// Single-flight: a second click (or a second tab) during a run gets the SAME token, so both
// windows watch one progress stream instead of racing two downloads at one folder.
let running: { token: string } | null = null;

/** Kick off an update in the background; returns the token to poll progress with. */
export function startEngineUpdate(deps: EngineDeps): string {
  if (running) return running.token;
  const token = randomBytes(16).toString('hex'); // 32 hex: the progress route's shape
  running = { token };
  const t = trackProgress(token);
  void updateEngine(deps, t.set)
    .then((r) => t.set(r.ok ? 100 : -1, r.ok ? `done:${r.tag}` : `error:${r.error}`))
    .catch((e) => t.set(-1, `error:${String(e)}`))
    .finally(() => { running = null; t.end(); });
  return token;
}
