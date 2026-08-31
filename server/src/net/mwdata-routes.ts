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
async function walk(root: string, dir = root, out: Entry[] = []): Promise<Entry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out; // an unreadable subfolder is not a reason to serve nothing
  }
  for (const name of names) {
    if (SKIP_DIR.test(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = await stat(full); } catch { continue; }
    if (st.isDirectory()) await walk(root, full, out);
    else if (st.isFile()) out.push({ p: relative(root, full).split(sep).join('/'), s: st.size });
  }
  return out;
}

export interface MwDataDeps {
  /** The folder the dashboard uploads into. */
  gameDataDir: string;
  /** The operator's stored answer. Only 'serve' publishes anything. */
  deliveryModel(): string;
}

export function mwDataRoutes(deps: MwDataDeps): HttpRoute {
  // The manifest is a directory walk over thousands of files, and the client asks for it once
  // per boot. Cached until the folder's own mtime moves, so a dashboard upload invalidates it
  // without anything having to remember to.
  let cache: { at: number; body: string } | undefined;

  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const isManifest = url.pathname === '/mwdata-manifest.json';
    const isFile = url.pathname.startsWith('/mwdata/');
    if (!isManifest && !isFile) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return true; }

    // Not serving? Then this path does not exist, and says so the same way for both routes:
    // a 403 would confirm there is a library here to be had.
    if (deps.deliveryModel() !== 'serve') { res.writeHead(404); res.end('not found'); return true; }

    if (isManifest) {
      let mtime = 0;
      try { mtime = (await stat(deps.gameDataDir)).mtimeMs; } catch { /* missing folder = empty */ }
      if (!cache || cache.at !== mtime) {
        const files = await walk(deps.gameDataDir);
        cache = { at: mtime, body: JSON.stringify(files) };
        log('info', 'mwdata.manifest_built', { files: files.length });
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : cache.body);
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
