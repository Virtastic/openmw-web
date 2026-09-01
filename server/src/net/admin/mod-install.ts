// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Installing a mod: upload the zip, choose what is inside it, extract.
//
// TWO STEPS, AND IT IS THE FORMAT THAT MAKES IT SO. A zip's central directory is at the END of
// the file, so nothing can be extracted while the bytes are still arriving. The archive has to
// land on disk before anything can be said about it. The staged file is not a shortcut around
// streaming; it is what streaming a zip means.
//
// The step between is the point of the whole feature. Nexus has no packaging standard, so an
// archive routinely holds "00 Core", "01 Optional Textures" and a readme — and installing all
// of them produces a game that looks installed and breaks somewhere else. The operator is asked
// which, with the contents of each spelled out.

import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { copyFile, rename, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { IncomingMessage } from 'node:http';

import { log } from '../../log';
import { findDataFolders, slugify, type Candidate } from '../../core/mod-archive';
import { extractEntry, listEntries, ZipError, type ZipEntry } from '../../core/zip';
import { extractSevenZip, listSevenZip, sniffArchive } from '../../core/sevenzip';
import { readMasters } from '../../core/esm';
import { identifyRelease, looksLikeTamrielRebuilt } from '../../core/tr-releases';
import { MOD_META as MODS_META_DIR } from '../../core/mod-conflicts';
import {
  MODS_SUBDIR, readModDoc, writeModDoc, type InstalledMod, type ModDoc, type ModPlugin,
} from '../../core/mods';

/** Where a staged upload waits between the two steps. Swept on a TTL, so NOTHING that must
 *  outlive the install may be written here. */
const STAGING = 'mod-staging';
/** Per-mod file lists, for conflict detection. Kept away from STAGING, whose sweep would
 *  eventually delete them. */
const MOD_META = MODS_META_DIR;
/** A staged zip nobody committed is rubbish after this long. Swept on the next upload. */
const STAGE_TTL_MS = 6 * 60 * 60 * 1000;

export type InstallResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/**
 * Serialises writes to modlist.json.
 *
 * Install, uninstall and reorder all read the document, change it and write it back. Two owners
 * acting at once — or one owner with two tabs — interleave those reads and the second write
 * silently discards the first change, which for an install means files on disk that no list
 * mentions. The same shape as the setupInFlight single-flight in routes.ts, and for the same
 * reason: one process, one document, one writer at a time.
 */
let writeChain: Promise<unknown> = Promise.resolve();
function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  // Keep the chain alive whatever happens: a rejection here must not stop later writers.
  writeChain = next.then(() => undefined, () => undefined);
  return next;
}

const fail = (status: number, error: string): InstallResult<never> => ({ ok: false, status, error });

/**
 * Live progress of a running install, keyed by the staged token, for the dashboard to poll.
 *
 * Extraction of Tamriel Data is minutes of work between one request and one response, and a
 * spinner that long reads as frozen. In memory and unbounded only in theory: commits are
 * serialised, so at most one entry is being written at a time, and each is deleted when its
 * install returns.
 */
const installProgress = new Map<string, { pct: number; note: string }>();
export const getInstallProgress = (token: string): { pct: number; note: string } | null =>
  installProgress.get(token) ?? null;

/**
 * Stream a request body to a file, with a byte cap.
 *
 * Lifted out of uploadContent rather than written again: that loop carries two fixes that were
 * each found the hard way — the `over` flag, because chunks already buffered keep arriving after
 * destroy(), and a temp name unique PER REQUEST, because in a container the pid is always 1 and
 * two uploads of one file shared a path.
 *
 * The sha256 is taken from the chunks ON THE WAY PAST, not by reading the file back: these
 * archives run to gigabytes, and hashing afterwards would mean a second full pass over a file
 * that has just been written — on a bind mount, minutes of it, for a value we had in hand.
 */
export async function streamToFile(
  req: IncomingMessage,
  target: string,
  cap: number,
): Promise<{ ok: true; bytes: number; sha256: string } | { ok: false; over: boolean; error: string }> {
  mkdirSync(dirname(target), { recursive: true });
  const out = createWriteStream(target);
  const digest = createHash('sha256');
  let written = 0;
  let over = false;
  try {
    await new Promise<void>((done, err) => {
      req.on('data', (chunk: Buffer) => {
        if (over) return;
        written += chunk.length;
        digest.update(chunk);
        if (written > cap) {
          over = true;
          out.destroy();
          req.destroy();
          err(new Error('over cap'));
          return;
        }
        if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
      });
      req.on('error', err);
      req.on('end', () => out.end(done));
      out.on('error', err);
    });
    return { ok: true, bytes: written, sha256: digest.digest('hex') };
  } catch (e) {
    await rm(target, { force: true });
    return { ok: false, over, error: String(e) };
  }
}

/** Delete staged uploads nobody came back for. No timer: this runs when the next one arrives. */
async function sweepStaging(dataDir: string): Promise<void> {
  const dir = join(dataDir, STAGING);
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  const cutoff = Date.now() - STAGE_TTL_MS;
  for (const n of names) {
    try {
      if (statSync(join(dir, n)).mtimeMs < cutoff) await rm(join(dir, n), { force: true });
    } catch { /* another request got there first */ }
  }
}

/**
 * List an archive of either kind.
 *
 * Sniffed by its first bytes, not its extension: people rename .7z to .zip believing that
 * converts it, and a .zip that is really a .7z would otherwise fail with a message about the
 * central directory that means nothing to anyone.
 */
async function listArchive(path: string): Promise<{ kind: 'zip' | '7z'; entries: ZipEntry[] }> {
  const kind = sniffArchive(path);
  if (kind === 'zip') return { kind, entries: listEntries(path) };
  if (kind === '7z') return { kind, entries: await listSevenZip(path) };
  if (kind === 'rar') {
    // p7zip in this image is built without the non-free RAR codec, so this is a real limit
    // rather than an oversight. Say what to do about it.
    throw new ZipError('RAR archives are not supported. Open it and save it as a .zip or .7z, '
      + 'which is what most mods are published as anyway.');
  }
  throw new ZipError('that does not look like a mod archive. Expected a .zip or a .7z.');
}

export interface Staged {
  token: string;
  archive: string;
  bytes: number;
  entries: number;
  /** sha256 of the uploaded archive, exactly as it arrived. Shown to the operator so an
   *  unrecognised release can be added to the table by copying it out of the page. */
  sha256: string;
  /** The release that hash is known to be, or null. Never a reason to refuse an install. */
  release: string | null;
  /** Whether the archive looks like Tamriel Rebuilt, for the wizard step that asks for it. */
  tamrielRebuilt: boolean;
  candidates: (Candidate & { suggestedSlug: string })[];
}

/** Step one: take the upload, look inside, and report what is in there. Nothing is installed. */
export async function beginInstall(
  req: IncomingMessage,
  dataDir: string,
  archiveName: string,
  cap: number,
): Promise<InstallResult<Staged>> {
  void sweepStaging(dataDir);

  const token = randomBytes(16).toString('hex');
  const path = join(dataDir, STAGING, `${token}.zip`);
  const got = await streamToFile(req, path, cap);
  if (!got.ok) {
    if (got.over) return fail(413, 'That archive is larger than the upload limit.');
    log('error', 'mods.stage_failed', { error: got.error });
    return fail(500, 'Could not save the upload. The data folder may be read-only or full.');
  }

  let entries: ZipEntry[];
  try {
    ({ entries } = await listArchive(path));
  } catch (e) {
    await rm(path, { force: true });
    // ZipError messages are written for the operator and name the fix; anything else is a bug.
    if (e instanceof ZipError) return fail(400, e.message);
    log('error', 'mods.zip_unreadable', { error: String(e) });
    return fail(400, 'That archive could not be read.');
  }

  const candidates = findDataFolders(entries.map((e) => ({ path: e.path, size: e.size, isDir: e.isDir })));
  if (candidates.length === 0) {
    await rm(path, { force: true });
    // Logged, and the message NAMES THE FILE: the first operator to hit this had uploaded the
    // Morrowind Code Patch (the file beside the Optimization Patch in their downloads), and an
    // anonymous refusal left them thinking the right archive was broken. Nothing in the log
    // said which file arrived either.
    log('info', 'mods.no_data_found', { archive: archiveName, entries: entries.length });
    const mcp = /code\s*patch/i.test(archiveName)
      ? ' (The Morrowind Code Patch patches the original engine\'s exe and does not apply to '
        + 'OpenMW; you may have meant the Morrowind Optimization Patch.)'
      : '';
    return fail(400, `No Morrowind data was found in ${archiveName}. A mod folder holds plugins `
      + '(.esp, .esm, .omwaddon, .omwscripts) or asset folders such as Meshes, Textures or Sound. '
      + `If the download contains a further archive inside it, unpack that one first.${mcp}`);
  }

  const release = identifyRelease(got.sha256);

  // The archive name is the operator's own label for this thing, and the commit arrives as a
  // separate request that has never seen it. Park it beside the zip rather than trusting the
  // browser to hand it back — and the identity with it, so the installed mod can record which
  // release it came from rather than throwing that away the moment the page moves on.
  try {
    writeFileSync(join(dataDir, STAGING, `${token}.json`),
      JSON.stringify({ archive: archiveName, sha256: got.sha256, release }));
  } catch { /* the name is a nicety; losing it must not fail the install */ }

  const base = archiveName.replace(/\.zip$/i, '');
  log('info', 'mods.staged', {
    archive: archiveName, bytes: got.bytes, candidates: candidates.length,
    sha256: got.sha256, release: release ?? 'unrecognised',
  });
  return {
    ok: true,
    value: {
      token,
      archive: archiveName,
      bytes: got.bytes,
      entries: entries.length,
      sha256: got.sha256,
      release,
      tamrielRebuilt: looksLikeTamrielRebuilt(entries.map((e) => e.path)),
      candidates: candidates.map((c) => ({
        ...c,
        // The archive name is what the operator recognises; the folder name inside it is
        // usually "00 Core", which names nothing.
        suggestedSlug: slugify(candidates.length > 1 && c.path !== '' ? `${base}-${c.path}` : base),
      })),
    },
  };
}

export interface Choice { path: string; slug: string; name: string }

/** Step two: extract the chosen folders, each into its own mod directory. */
export function commitInstall(
  dataDir: string,
  gameDataDir: string,
  token: string,
  choices: Choice[],
): Promise<InstallResult<InstalledMod[]>> {
  return serialise(() => commitInstallLocked(dataDir, gameDataDir, token, choices));
}

async function commitInstallLocked(
  dataDir: string,
  gameDataDir: string,
  token: string,
  choices: Choice[],
): Promise<InstallResult<InstalledMod[]>> {
  if (!/^[0-9a-f]{32}$/.test(token)) return fail(400, 'That upload has expired. Please upload again.');
  const zipPath = join(dataDir, STAGING, `${token}.zip`);
  if (!existsSync(zipPath)) return fail(400, 'That upload has expired. Please upload again.');
  if (choices.length === 0) return fail(400, 'Nothing was selected to install.');

  let entries: ZipEntry[];
  let kind: 'zip' | '7z';
  try { ({ entries, kind } = await listArchive(zipPath)); } catch (e) {
    return fail(400, e instanceof ZipError ? e.message : 'That archive could not be read.');
  }

  // A .7z has no cheap random access -- pulling one file at a time would re-walk a solid block
  // for each -- so it is unpacked once, whole, into a scratch directory and the chosen subtree
  // is taken from there. A zip streams entry by entry and needs no scratch space at all.
  //
  // THE SCRATCH IS LOCAL DISK, NOT THE GAME DATA VOLUME. gamedata is a bind mount under
  // Docker Desktop, and 7z writing 54,000 small files through that file-sharing layer was
  // measured at 60+ minutes for Tamriel Data — the same extraction to the container's own
  // disk takes about three. The price is that placing files becomes a copy across the mount
  // instead of a same-volume rename, which is why the placing loop below runs a POOL of
  // copies: one at a time was measured at 756s for that archive, sixteen at a time at 108s —
  // the mount charges per round trip, not per byte, so the round trips have to overlap.
  // Extraction owns 0-60 of the bar and placing the rest; a zip decompresses per entry in
  // the placing loop, which is then the whole bar.
  const placeBase = kind === '7z' ? 60 : 0;
  installProgress.set(token, { pct: 0, note: 'unpacking the archive' });

  let scratch = '';
  if (kind === '7z') {
    const stageRoot = join(tmpdir(), 'omw-mod-stage');
    scratch = join(stageRoot, token);
    try {
      // A crash mid-install would orphan an earlier scratch, so leftovers go here, on the
      // next install — both in today's stage root and in the mods folder, where an older
      // build kept its scratch (.stage-*) and an upgrade would otherwise strand one forever.
      await rm(stageRoot, { recursive: true, force: true });
      mkdirSync(join(gameDataDir, MODS_SUBDIR), { recursive: true }); // first install: no mods dir yet
      for (const n of readdirSync(join(gameDataDir, MODS_SUBDIR), { withFileTypes: true })) {
        if (n.isDirectory() && n.name.startsWith('.stage-')) {
          await rm(join(gameDataDir, MODS_SUBDIR, n.name), { recursive: true, force: true });
        }
      }
      mkdirSync(scratch, { recursive: true });
      await extractSevenZip(zipPath, scratch, (pct) => {
        installProgress.set(token, {
          pct: Math.round((pct * placeBase) / 100), note: 'unpacking the archive',
        });
      });
    } catch (e) {
      await rm(scratch, { recursive: true, force: true });
      return fail(400, e instanceof ZipError ? e.message : 'That archive could not be unpacked.');
    }
  }

  let archiveName = '';
  let release = '';
  try {
    const note = JSON.parse(readFileSync(join(dataDir, STAGING, `${token}.json`), 'utf8')) as
      { archive?: unknown; release?: unknown };
    archiveName = String(note.archive ?? '');
    release = typeof note.release === 'string' ? note.release : '';
  } catch { /* pre-existing staging, or the note was swept: the name is not load-bearing */ }

  const doc = readModDoc(dataDir);
  const taken = new Set(doc.mods.map((m) => m.slug));
  const installed: InstalledMod[] = [];
  let placed = 0;

  for (const choice of choices) {
    // The slug becomes a directory name and a URL segment, so it is regenerated here rather
    // than trusted: the browser sent it, and the browser is not where this decision lives.
    let slug = slugify(choice.slug || choice.name || 'mod');
    if (taken.has(slug)) {
      let n = 2;
      while (taken.has(`${slug}-${n}`)) n++;
      slug = `${slug}-${n}`;
    }
    taken.add(slug);

    const root = join(gameDataDir, MODS_SUBDIR, slug);
    // The assertion that actually matters, after every path has been resolved.
    if (!resolve(root).startsWith(resolve(join(gameDataDir, MODS_SUBDIR)) + sep)) {
      return fail(400, 'refused: that mod name escapes the mods folder');
    }

    const prefix = choice.path === '' ? '' : `${choice.path}/`;
    const plugins: ModPlugin[] = [];
    const archives: string[] = [];
    const files: string[] = [];
    let bytes = 0;

    try {
      mkdirSync(root, { recursive: true });
      // Validate and book-keep first, serially — this is string work and the order of `files`
      // and the plugin list must be the entry order, not whichever copy finished first.
      const jobs: { src: string; dest: string; entry: ZipEntry }[] = [];
      for (const e of entries) {
        if (e.isDir || (prefix !== '' && !e.path.startsWith(prefix))) continue;
        const rel = e.path.slice(prefix.length);
        if (rel === '') continue;
        const dest = resolve(root, rel);
        // Third check, on the real destination. listEntries already refused traversal in the
        // NAMES; this refuses it in the RESULT, which is the thing that can actually be written.
        if (!dest.startsWith(resolve(root) + sep)) {
          throw new ZipError(`refused: ${e.path} escapes the mod folder`);
        }
        mkdirSync(dirname(dest), { recursive: true });
        jobs.push({ src: join(scratch, e.path), dest, entry: e });
        files.push(rel.split(sep).join('/'));
        bytes += e.size;
        const name = rel.slice(rel.lastIndexOf('/') + 1);
        if (/\.(esp|esm|omwaddon|omwgame|omwscripts)$/i.test(name)) {
          plugins.push({ file: name, enabled: true });
        } else if (/\.(bsa|ba2)$/i.test(name)) {
          archives.push(name);
        }
      }

      // Then move the bytes. A zip decompresses entry by entry and stays serial — the work is
      // CPU, not round trips. A 7z's files already sit on local disk and the cost is the bind
      // mount's per-operation latency, so SIXTEEN copies run at once (see the measurement at
      // the scratch declaration). rename is tried first because on a same-volume layout (a
      // native install, or an operator who moved the scratch) it is free; across the mount it
      // fails once with EXDEV and the copy does the work.
      if (kind === 'zip') {
        for (const j of jobs) {
          await extractEntry(zipPath, j.entry, j.dest);
          placed++;
          if (placed % 100 === 0) {
            installProgress.set(token, {
              pct: Math.min(99, Math.round((100 * placed) / jobs.length)), note: 'placing files',
            });
          }
        }
      } else {
        let next = 0;
        const worker = async () => {
          for (;;) {
            const n = next++;
            if (n >= jobs.length) return;
            const j = jobs[n]!;
            try { await rename(j.src, j.dest); }
            catch { await copyFile(j.src, j.dest); }
            placed++;
            // Every 100 files, not every file: the map write is cheap but not free, and at
            // Tamriel Data's 54,000 files once per file is 54,000 times nobody can see.
            if (placed % 100 === 0) {
              installProgress.set(token, {
                pct: Math.min(99, placeBase + Math.round(((100 - placeBase) * placed) / jobs.length)),
                note: 'placing files',
              });
            }
          }
        };
        await Promise.all(Array.from({ length: 16 }, worker));
      }
    } catch (e) {
      // Half a mod is worse than none: it would contribute a data= line and a content= naming
      // a plugin that may not have made it, which aborts the engine at startup.
      //
      // EVERY folder from this request, not just the one that failed. The document is written
      // once at the end, so an earlier choice that extracted cleanly is on disk and in no list
      // — served to players by /mwdata, counted by the manifest walk, and invisible in the
      // dashboard, with no way to remove it from there.
      await rm(root, { recursive: true, force: true });
      for (const done of installed) {
        await rm(join(gameDataDir, MODS_SUBDIR, done.slug), { recursive: true, force: true });
        await rm(join(dataDir, MOD_META, `${done.slug}.json`), { force: true });
      }
      if (scratch) await rm(scratch, { recursive: true, force: true });
      installProgress.delete(token);
      log('warn', 'mods.install_failed', { slug, error: String(e) });
      return fail(400, e instanceof ZipError ? e.message
        : `Could not install ${choice.name || slug}. The game data folder may be full.`);
    }

    // Only plugins directly in the mod's root are load-order entries. One inside Meshes/ is
    // somebody's backup, not something to name in content= — and naming a file the engine
    // cannot resolve aborts startup.
    // Read each plugin's declared masters now, while the files are in front of us. A missing
    // master aborts the engine at startup rather than skipping the mod, so the dashboard needs
    // to be able to warn about a disable BEFORE it is saved.
    const rootPlugins = plugins.filter((p) => files.includes(p.file)).map((p) => {
      const masters = readMasters(join(root, p.file));
      return masters.length ? { ...p, masters } : p;
    });
    installed.push({
      slug,
      name: (choice.name || slug).slice(0, 120),
      archive: archiveName,
      ...(release ? { release } : {}),
      source: choice.path,
      installedAt: new Date().toISOString(),
      enabled: true,
      plugins: rootPlugins,
      archives: archives.filter((a) => files.includes(a)),
      files: files.length,
      bytes,
    });
    // Not in STAGING: that folder is swept on a TTL, which would quietly delete the file lists
    // conflict detection reads and leave every mod looking conflict-free.
    mkdirSync(join(dataDir, MOD_META), { recursive: true });
    writeFileSync(join(dataDir, MOD_META, `${slug}.json`), JSON.stringify(files));
  }

  const next: ModDoc = { ...doc, mods: [...doc.mods, ...installed] };
  const wrote = writeModDoc(dataDir, next);
  if (!wrote.ok) {
    for (const m of installed) await rm(join(gameDataDir, MODS_SUBDIR, m.slug), { recursive: true, force: true });
    installProgress.delete(token);
    return fail(500, wrote.error);
  }
  // Both halves of the staging pair. Leaving the note behind describes an archive that has
  // already been installed, and the sweep would not touch it for six hours.
  await rm(zipPath, { force: true });
  await rm(join(dataDir, STAGING, `${token}.json`), { force: true });
  if (scratch) await rm(scratch, { recursive: true, force: true });
  installProgress.delete(token);
  log('info', 'mods.installed', { slugs: installed.map((m) => m.slug) });
  return { ok: true, value: installed };
}

/** Remove a mod: its folder, its entry, and its file list. */
export function uninstallMod(
  dataDir: string,
  gameDataDir: string,
  slug: string,
): Promise<InstallResult<{ slug: string }>> {
  return serialise(() => uninstallModLocked(dataDir, gameDataDir, slug));
}

async function uninstallModLocked(
  dataDir: string,
  gameDataDir: string,
  slug: string,
): Promise<InstallResult<{ slug: string }>> {
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) return fail(400, 'That is not a mod name.');
  const doc = readModDoc(dataDir);
  if (!doc.mods.some((m) => m.slug === slug)) return fail(404, 'No such mod.');

  const root = join(gameDataDir, MODS_SUBDIR, slug);
  if (!resolve(root).startsWith(resolve(join(gameDataDir, MODS_SUBDIR)) + sep)) {
    return fail(400, 'refused: that mod name escapes the mods folder');
  }
  // The DOCUMENT first. If the delete half fails, a mod that is gone from the list leaves
  // files nothing references; the other order leaves an entry pointing at nothing, which is
  // a content= line for a file the engine cannot open.
  const wrote = writeModDoc(dataDir, { ...doc, mods: doc.mods.filter((m) => m.slug !== slug) });
  if (!wrote.ok) return fail(500, wrote.error);
  await rm(root, { recursive: true, force: true });
  await rm(join(dataDir, MOD_META, `${slug}.json`), { force: true });
  log('info', 'mods.uninstalled', { slug });
  return { ok: true, value: { slug } };
}

/** Apply the operator's ordering and switches. Order of the incoming array is the load order. */
export function saveModOrder(
  dataDir: string,
  incoming: { slug?: unknown; enabled?: unknown; plugins?: unknown }[],
): InstallResult<{ count: number }> {
  const doc = readModDoc(dataDir);
  const known = new Map(doc.mods.map((m) => [m.slug, m]));
  const next: InstalledMod[] = [];
  const seen = new Set<string>();

  for (const row of incoming) {
    const slug = typeof row.slug === 'string' ? row.slug : '';
    const mod = known.get(slug);
    // Refused rather than ignored, matching saveMods: a list naming something that is not
    // there is a list the operator is wrong about, and silently dropping it hides that.
    if (!mod) return fail(400, `no such mod: ${slug}`);
    if (seen.has(slug)) return fail(400, `listed twice: ${slug}`);
    seen.add(slug);

    const wanted = Array.isArray(row.plugins)
      ? new Map((row.plugins as { file?: unknown; enabled?: unknown }[])
        .filter((p) => typeof p.file === 'string')
        .map((p) => [(p.file as string).toLowerCase(), p.enabled !== false]))
      : null;
    next.push({
      ...mod,
      enabled: row.enabled !== false,
      plugins: mod.plugins.map((p) => ({ ...p, enabled: wanted?.get(p.file.toLowerCase()) ?? p.enabled })),
    });
  }
  // A mod the browser did not mention keeps its place at the end rather than vanishing: the
  // page may be a version behind, and a save should not delete what it never knew about.
  for (const m of doc.mods) if (!seen.has(m.slug)) next.push(m);

  const wrote = writeModDoc(dataDir, { ...doc, mods: next });
  return wrote.ok ? { ok: true, value: { count: next.length } } : fail(500, wrote.error);
}
