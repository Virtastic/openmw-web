// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// "This server hands out the files", made real.
//
// The wizard's delivery step offers two answers and only one of them was wired. Picking
// "everyone brings their own copy" works: each player uploads to their own locker. Picking
// "this server hands out the files" set a single upload-leniency flag and nothing else, so
// the operator uploaded their Data Files through the dashboard, was told everyone would
// receive them, and then every player — including the operator — was asked to upload the
// same files again into a personal locker. The answer was collected, echoed on the review
// screen, and dropped.
//
// NOTHING NEW IS INVENTED HERE. play/index.html has carried a complete server-hosted data
// path the whole time: it fetches mwdata-manifest.json, StreamFS-mounts every entry, and
// reads byte ranges on demand, so a 1.1 GB library costs no upload and nothing resident up
// front. Its own comment says "a self-host can drop a real Data Files folder there and it
// just works". What was missing was the two routes that publish the folder the dashboard
// already uploads into. This is that, and only that.
//
// GATED ON THE ANSWER, deliberately checked per request rather than captured at boot. Serving
// Morrowind to whoever asks is a decision with legal weight (see docs/LEGAL.md), so it holds
// only while the operator's stored answer still says to, and turning it off in the dashboard
// takes effect on the next request rather than at the next restart.

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpRoute } from './http';
import { log } from '../log';
import { MODS_SUBDIR, resolveMods, type ModDoc } from '../core/mods';

/** One entry of mwdata-manifest.json: `p`ath relative to the folder, and `s`ize. */
interface Entry { p: string; s: number }

/** Skipped wholesale: not game data, and one of them is an operator secret. */
const SKIP_DIR = /^(\.|__pycache__$|node_modules$)/;

/**
 * Walk the game-data folder into the manifest the client expects.
 *
 * Forward slashes regardless of platform: these are URL path segments, and the client
 * concatenates them onto "mwdata/" to fetch. A Windows operator's backslashes would produce
 * URLs that 404 on their own machine.
 */
async function walk(root: string, dir = root, out: Entry[] = [], skip?: string): Promise<Entry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out; // an unreadable subfolder is not a reason to serve nothing
  }
  for (const name of names) {
    if (SKIP_DIR.test(name)) continue;
    const full = join(dir, name);
    if (skip !== undefined && dir === root && name === skip) continue;
    let st;
    try { st = await stat(full); } catch { continue; }
    if (st.isDirectory()) await walk(root, full, out, skip);
    else if (st.isFile()) out.push({ p: relative(root, full).split(sep).join('/'), s: st.size });
  }
  return out;
}

export interface MwDataDeps {
  /** The folder the dashboard uploads into. */
  gameDataDir: string;
  /** The operator's stored answer. Only 'serve' publishes anything. */
  deliveryModel(): string;
  /** Installed mods, in order. Read per request so a change lands without a restart. */
  modDoc?(): ModDoc;
}

export function mwDataRoutes(deps: MwDataDeps): HttpRoute {
  // The manifest is a directory walk over thousands of files, and the client asks for it once
  // per boot. Cached until the folder's own mtime moves, so a dashboard upload invalidates it
  // without anything having to remember to.
  let cache: { at: number; body: string } | undefined;
  // The mod sidecar is its own walk over every installed mod's tree. Tamriel Rebuilt is around
  // 40,000 files, and this was rebuilt from scratch on every request — the client asks once per
  // boot, but nothing stops anything else asking. Same mtime key as the manifest above.
  let modCache: { at: string; body: string } | undefined;

  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const isManifest = url.pathname === '/mwdata-manifest.json';
    const isMods = url.pathname === '/mwdata-mods.json';
    const isFile = url.pathname.startsWith('/mwdata/');
    if (!isManifest && !isMods && !isFile) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return true; }

    // Not serving? Then this path does not exist, and says so the same way for both routes:
    // a 403 would confirm there is a library here to be had.
    if (deps.deliveryModel() !== 'serve') { res.writeHead(404); res.end('not found'); return true; }

    if (isManifest) {
      // BOTH directories. Creating gamedata/mods bumps gamedata's mtime once, when the folder
      // first appears; every install after that bumps gamedata/mods and leaves the parent
      // untouched — so a single-stat cache serves a stale manifest from the SECOND mod onwards,
      // with a dashboard that looks right and a browser that never sees the files.
      let mtime = 0;
      try { mtime = (await stat(deps.gameDataDir)).mtimeMs; } catch { /* missing folder = empty */ }
      try { mtime += (await stat(join(deps.gameDataDir, MODS_SUBDIR))).mtimeMs; } catch { /* no mods yet */ }
      if (!cache || cache.at !== mtime) {
        const files = await walk(deps.gameDataDir, deps.gameDataDir, [], MODS_SUBDIR);
        cache = { at: mtime, body: JSON.stringify(files) };
        log('info', 'mwdata.manifest_built', { files: files.length });
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : cache.body);
      return true;
    }

    // THE MOD STACK, as a SEPARATE file from the flat manifest.
    //
    // mwdata-manifest.json is a JSON ARRAY, and a cached older index.html does `list.length` and
    // `list.forEach` on it. Wrapping it in an object to carry mod metadata would turn every one
    // of those clients into "No game data on this server" — a failure that reads as the server
    // breaking rather than as a version skew. So the array keeps its shape and its meaning, and
    // this sidecar carries what is new. A 404 here is an ordinary answer meaning "no mods".
    //
    // Built from the same resolveMods() the peer's cfg comes from, so the browser and the
    // headless engine cannot end up running different load orders.
    if (isMods) {
      const doc = deps.modDoc?.();
      if (!doc || doc.mods.length === 0) { res.writeHead(404); res.end('not found'); return true; }

      // Keyed on the mods directory's mtime AND the enabled set, because switching a mod off
      // changes the answer without moving a single file on disk.
      let modsAt = '';
      try { modsAt = String((await stat(join(deps.gameDataDir, MODS_SUBDIR))).mtimeMs); } catch { /* none */ }
      const key = `${modsAt}|${doc.mods.map((m) => `${m.slug}:${m.enabled ? 1 : 0}`
        + `:${m.plugins.filter((p) => p.enabled).map((p) => p.file).join(',')}`).join('|')}`;
      if (modCache && modCache.at === key) {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : modCache.body);
        return true;
      }

      const stack = resolveMods(doc);
      const enabled = doc.mods.filter((m) => m.enabled);
      const mods = [];
      for (const m of enabled) {
        // Files are listed per mod so the client can mount each into its own data= root. Only
        // for ENABLED mods: a disabled 20k-file mod would be a megabyte of JSON on every boot,
        // describing files nothing will mount.
        const files = await walk(join(deps.gameDataDir, MODS_SUBDIR, m.slug));
        mods.push({
          slug: m.slug,
          name: m.name,
          plugins: m.plugins.filter((p) => p.enabled).map((p) => p.file),
          // What each plugin declares it needs. The client cannot ask the files themselves —
          // they are lazily mounted, not read — and a plugin whose master is absent aborts the
          // engine, so it has to be told in order to drop one rather than emit it.
          masters: m.plugins
            .filter((p) => p.enabled && (p.masters?.length ?? 0) > 0)
            .map((p) => ({ file: p.file, needs: p.masters })),
          archives: m.archives,
          files,
        });
      }
      const body = JSON.stringify({ v: 2, mods, content: stack.content, archives: stack.archives });
      modCache = { at: key, body };
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    }

    // TRAVERSAL. The rest of the path is attacker-controlled, and it becomes a real filesystem
    // path, so resolve it and prove the result is still inside the folder. The same check
    // FsStorage.pathFor makes, for the same reason: a prefix test on the raw string is not
    // enough once '..' segments and symlinks are in play.
    let path: string;
    try {
      const rel = decodeURIComponent(url.pathname.slice('/mwdata/'.length));
      if (rel === '' || rel.includes('\0')) throw new Error('bad path');
      path = resolve(deps.gameDataDir, rel);
      if (!path.startsWith(resolve(deps.gameDataDir) + sep)) throw new Error('escape');
    } catch {
      res.writeHead(404); res.end(); return true;
    }

    let size: number;
    try {
      const st = await stat(path);
      if (!st.isFile()) throw new Error('not a file');
      size = st.size;
    } catch {
      res.writeHead(404); res.end(); return true;
    }

    // RANGES ARE THE WHOLE POINT. StreamFS mounts each file and reads slices of it for the
    // length of the session; without 206 support the engine would pull entire BSAs into
    // memory, which is exactly what this path exists to avoid.
    const head: Record<string, string> = {
      'accept-ranges': 'bytes',
      'content-type': 'application/octet-stream',
      // Immutable: retail game files do not change under a running session, and re-fetching
      // hundreds of megabytes on every boot is the difference between usable and not.
      'cache-control': 'public, max-age=31536000, immutable',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && (range[1] !== '' || range[2] !== '')) {
      // A suffix range ("-500") is the last N bytes; otherwise start..end inclusive.
      const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
      const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
      if (!Number.isFinite(start) || start > end || start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        return true;
      }
      res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': String(end - start + 1) });
      if (req.method === 'HEAD') { res.end(); return true; }
      createReadStream(path, { start, end }).pipe(res);
      return true;
    }

    res.writeHead(200, { ...head, 'content-length': String(size) });
    if (req.method === 'HEAD') { res.end(); return true; }
    createReadStream(path).pipe(res);
    return true;
  };
}
