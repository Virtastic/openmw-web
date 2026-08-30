// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Wire helpers shared by every admin route. Small on purpose: the dashboard speaks JSON to
// its own page and nothing else, so there is no framework here to earn its keep.

import type { IncomingMessage, ServerResponse } from 'node:http';

export function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(s),
    // The dashboard is an authenticated control surface; nothing here should ever be
    // cached by a proxy or replayed from a back button.
    'cache-control': 'no-store',
  });
  res.end(s);
}

/**
 * Read a JSON request body with a hard ceiling. Returns undefined (and answers the request)
 * on anything malformed, so callers can `if (body === undefined) return true;`.
 */
export async function readJson<T>(
  req: IncomingMessage,
  res: ServerResponse,
  limit = 64 * 1024,
): Promise<T | undefined> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) { json(res, 413, { error: 'too large' }); return undefined; }
  }
  try {
    return JSON.parse(raw || '{}') as T;
  } catch {
    json(res, 400, { error: 'bad json' });
    return undefined;
  }
}

export function html(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    // The dashboard renders operator-supplied strings (server name, MOTD, ban reasons).
    // Everything it loads is same-origin and vendored, so the strictest useful policy costs
    // nothing and turns any missed escape from a scripting hole into a blocked load.
    'content-security-policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
      "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

/** HTML-escape for the few places the server builds markup itself. */
export function esc(s: unknown): string {
  return String(s).replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]!));
}
