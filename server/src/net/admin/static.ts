// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Serves server/web/ — the dashboard page and its vendored AdminLTE/Bootstrap assets.
//
// Everything is VENDORED, never a CDN. This tool has to work on a LAN with no internet, on
// a fresh box behind a corporate proxy, and at 2am when a CDN is the thing that is down —
// the same reasoning the original one-file dashboard wrote down, applied to a bigger page.
//
// Resolves from both src/ (tsx) and dist/ (bundle), exactly like config.default.toml.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, extname, normalize, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

const WEB_ROOT = fileURLToPath(new URL('../../../web/', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

/**
 * Read a file under web/. Returns undefined for anything that escapes the root — the path
 * comes from a URL, so "../../etc/passwd" is a thing that will be tried.
 */
export function readWebFile(rel: string): { body: Buffer; type: string } | undefined {
  const clean = normalize(rel).replace(/^([/\\]|\.\.[/\\])+/, '');
  const full = join(WEB_ROOT, clean);
  if (!full.startsWith(WEB_ROOT.endsWith(sep) ? WEB_ROOT : WEB_ROOT + sep)) return undefined;
  if (!existsSync(full) || !statSync(full).isFile()) return undefined;
  return { body: readFileSync(full), type: TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream' };
}

export function serveWebFile(res: ServerResponse, rel: string): boolean {
  const file = readWebFile(rel);
  if (!file) return false;
  res.writeHead(200, {
    'content-type': file.type,
    'content-length': file.body.length,
    // Vendored assets are immutable for a given build; the dashboard's own files are not,
    // and a stale app.js against a new API is a confusing bug to chase.
    'cache-control': rel.startsWith('vendor/') ? 'public, max-age=86400' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  res.end(file.body);
  return true;
}
