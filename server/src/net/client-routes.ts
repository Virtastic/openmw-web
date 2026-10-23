// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The player app (./play, mounted at /client), served by this server itself.
//
// Only Caddy used to serve it, so a self-host that published the server's own port and no
// Caddy — docker-compose.simple.yml, or anyone with their own proxy — had a sign-in page that
// said "the player app has not been added" over a folder that held it (issue #203). Caddy is
// now a plain TLS front that proxies everything here, so these rules exist once.
//
// What Caddy's file block did, and what this does:
//  - cross-origin isolation on every response: the engine's threads need SharedArrayBuffer,
//    which needs COOP + COEP on the document and CORP on what it loads;
//  - the release's .br/.gz siblings when the browser takes them and they are not older than the
//    file (an older .br is a previous engine: see play/server.py, which has the same rule);
//  - /join is launcher.html under its own path (door mode reads location.pathname);
//  - /launcher.html goes to / when the chooser is off (the game's exits link to it);
//  - the release's operator files (server.py, .env, the desktop shortcuts) and every dotfile
//    the updater leaves (.release-tag, .staging/) are not part of the site.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpRoute } from './http';
import { TYPES } from './admin/static';

/** Where the player app is mounted: /client in the Docker images, OMW_CLIENT where the volume lives elsewhere (Pterodactyl/Pelican). */
export const defaultClientDir = (): string => process.env.OMW_CLIENT || '/client';

export interface ClientDeps {
  /** The folder holding index.html, launcher.html and e/<hash>/. */
  clientDir: string;
  /** The launcher chooser is reachable (OMW_ENABLE_LAUNCHER, or a multiplayer server). Per request. */
  launcher(): boolean;
}

export const ISOLATION: Record<string, string> = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'cross-origin',
};

/** Not part of the site. `mwdata/` is the operator's game folder in dev layouts: it is served,
 *  when at all, by mwdata-routes, behind the delivery answer. */
function denied(segs: string[]): boolean {
  if (segs.some((s) => s === '' || s.startsWith('.') || s.includes('\0') || s.includes('\\'))) return true;
  const last = segs[segs.length - 1]!.toLowerCase();
  if (segs[0] === 'mwdata' || segs[0] === '__pycache__') return true;
  if (segs.length === 1 && (last === 'server.py' || last === 'start-here.txt')) return true;
  return last.endsWith('.bat') || last.endsWith('.command');
}

async function fileAt(path: string): Promise<{ size: number; mtime: number } | undefined> {
  try {
    const st = await stat(path);
    return st.isFile() ? { size: st.size, mtime: st.mtimeMs } : undefined;
  } catch { return undefined; }
}

export function clientRoutes(deps: ClientDeps): HttpRoute {
  const root = resolve(deps.clientDir);
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let rel: string;
    try { rel = decodeURIComponent(url.pathname); } catch { return false; }

    if (rel === '/join') rel = '/launcher.html';
    else if (rel === '/launcher.html' && !deps.launcher()) {
      res.writeHead(302, { location: '/', ...ISOLATION }); res.end(); return true;
    }

    const segs = rel.slice(1).split('/');
    if (denied(segs)) return false;
    const path = resolve(root, ...segs);
    if (!path.startsWith(root + sep)) return false;
    const orig = await fileAt(path);
    if (!orig) return false;

    // A pre-compressed sibling, when the browser takes it and it was written with or after the
    // file. Ranges are only offered on the plain bytes.
    const accept = String(req.headers['accept-encoding'] ?? '');
    let sendPath = path;
    let sent = orig;
    let encoding: string | undefined;
    if (!req.headers.range) {
      for (const [enc, ext] of [['br', '.br'], ['gzip', '.gz']] as const) {
        if (!new RegExp(`\\b${enc}\\b`).test(accept)) continue;
        const sib = await fileAt(path + ext);
        if (sib && sib.mtime >= orig.mtime) { sendPath = path + ext; sent = sib; encoding = enc; break; }
      }
    }

    const etag = `"${sent.size.toString(16)}-${Math.floor(sent.mtime).toString(16)}${encoding ? `-${encoding}` : ''}"`;
    const isPage = extname(path) === '.html';
    const head: Record<string, string> = {
      ...ISOLATION,
      'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      vary: 'accept-encoding',
      // Engine files live under e/<content hash>/: a new engine is a new URL. Everything else
      // (the pages, an unstamped dev layout) revalidates; the ETag makes that a 304.
      'cache-control': !isPage && segs[0] === 'e' ? 'public, max-age=31536000, immutable' : 'no-cache',
      etag,
    };
    if (encoding) head['content-encoding'] = encoding;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); res.end(); return true; }

    const size = sent.size;
    const ifRange = req.headers['if-range'];
    const range = encoding || (ifRange !== undefined && ifRange !== etag) ? null
      : /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && (range[1] !== '' || range[2] !== '')) {
      const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
      const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
      if (!Number.isFinite(start) || start > end || start >= size) {
        res.writeHead(416, { ...ISOLATION, 'content-range': `bytes */${size}` }); res.end(); return true;
      }
      res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) });
      if (req.method === 'HEAD') { res.end(); return true; }
      createReadStream(sendPath, { start, end }).pipe(res);
      return true;
    }
    res.writeHead(200, { ...head, 'content-length': String(size) });
    if (req.method === 'HEAD') { res.end(); return true; }
    createReadStream(sendPath).pipe(res);
    return true;
  };
}
