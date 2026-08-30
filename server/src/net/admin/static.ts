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

// TWO LAYOUTS, ONE FILE.
//
// Running from source this module is at src/net/admin/static.ts, so web/ is three levels
// up. Running from the bundle it is inlined into dist/server.mjs, one level up. Neither
// path works in both places, so both are tried and the first that exists wins.
//
// config.default.toml gets away with a single '../' only because src/config.ts and
// dist/server.mjs happen to sit at the same depth. Nothing enforces that, and this file is
// the case where the coincidence runs out — the dev server served the dashboard perfectly
// while the container answered 500, because only the bundle takes the second path.
const WEB_ROOT = ((): string => {
  for (const rel of ['../../../web/', '../web/']) {
    const candidate = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(candidate)) return candidate;
  }
  // Nothing found: keep the source-layout path so error messages point somewhere sensible.
  return fileURLToPath(new URL('../../../web/', import.meta.url));
})();

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
  const isPage = file.type.startsWith('text/html');
  res.writeHead(200, {
    'content-type': file.type,
    'content-length': file.body.length,
    // Vendored assets are immutable for a given build; the dashboard's own files are not,
    // and a stale app.js against a new API is a confusing bug to chase.
    'cache-control': rel.startsWith('vendor/') ? 'public, max-age=86400' : 'no-cache',
    'x-content-type-options': 'nosniff',
    ...(isPage ? PAGE_HEADERS : {}),
  });
  res.end(file.body);
  return true;
}

// Everything the dashboard loads is same-origin and vendored, so the strictest policy that
// still works costs nothing and turns any missed escape into a blocked load rather than a
// scripting hole.
//
// frame-ancestors matters as much as script-src here: the buttons on this page restart the
// server, ban and erase accounts, and run script on a player's machine. Without it those are
// one invisible iframe and a misplaced click away.
//
// 'unsafe-inline' for styles only — Bootstrap components set inline styles, and no inline
// <style> or style attribute can execute anything. Scripts get no such exemption.
const PAGE_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    + "img-src 'self' data:; font-src 'self'; connect-src 'self'; "
    + "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};
