// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Plain HTTP endpoints on the same server the WSS attaches to:
// /healthz -> "ok", /status -> public JSON snapshot, /metrics -> token-gated scrape,
// and (Phase B) an optional /auth/* group supplied by src/auth/routes.ts.
//
// The query/cookie/redirect helpers live here because this file owns the raw request:
// routes get a parsed URL and these three primitives, and nothing else.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { renderMetrics } from '../metrics';
import { log } from '../log';

// M8 lobby payload: everything a launcher needs to list a server and offer join-by-URL,
// and NOTHING more. Deliberately absent: IP addresses, account names (the `name` here is
// the in-game display name a player chose to show to every other player anyway), ranks,
// bans, and any per-player identifier beyond the transient session playerId.
export interface StatusSnapshot {
  name: string;
  motd: string;
  players: { id: number; name: string; cellKey: string | null; level?: number }[];
  playerCount: number; // humans IN A CELL — the lobby's "who's playing" number
  // F3: humans CONNECTED (authed), whether in a cell yet or still at the menu / in character
  // creation. The gateway reaps an idle world on THIS, not playerCount — otherwise a player
  // creating a character (not in a cell yet) reads as idle and their world is killed under them.
  connectedCount: number;
  maxPlayers: number;
  contentPolicy: 'names' | 'strict' | 'off';
  enginePolicy: 'warn' | 'refuse' | 'off';
  requiresPassword: boolean; // a launcher can prompt before connecting
  allowsRegistration: boolean; // false when registration is off OR invite-only
  pvp: boolean;
  uptime: number; // seconds
  version: string;
}

// enabled=false or an empty token makes /metrics indistinguishable from any other unknown
// path (404, not 401) — a prober must not learn that the endpoint exists here.
export interface MetricsOptions {
  enabled: boolean;
  token: string;
}

// Returns true when the route consumed the request. Rejections are caught by the caller.
export type HttpRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean>;

function bearerOk(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const got = Buffer.from(header.slice(7));
  const want = Buffer.from(token);
  // Length is compared separately because timingSafeEqual throws on a mismatch; token
  // length is not the secret.
  return got.length === want.length && timingSafeEqual(got, want);
}

// ------------------------------------------------------------------- helpers

export function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? '';
}

// True when the browser reached us over TLS, directly or through a terminating proxy.
// Only used to decide whether a Secure cookie is safe to set: setting Secure on a plain
// http:// dev listener makes the browser DROP the cookie, which breaks the state check.
export function isSecureRequest(req: IncomingMessage): boolean {
  const proto = req.headers['x-forwarded-proto'];
  const first = (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0]?.trim();
  if (first) return first === 'https';
  return 'encrypted' in req.socket;
}

export function readCookie(req: IncomingMessage, name: string): string {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return ''; // malformed percent-encoding: treat as absent, never throw on input
    }
  }
  return '';
}

export interface CookieOptions {
  maxAgeSec: number; // 0 clears the cookie
  path: string;
  secure: boolean;
}

// httpOnly + SameSite=Lax: the state cookie must survive the provider's top-level GET
// redirect back to us (Lax does; Strict would not) and must be unreadable from script.
export function setCookie(res: ServerResponse, name: string, value: string, opts: CookieOptions): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path}`,
    `Max-Age=${opts.maxAgeSec}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (opts.secure) parts.push('Secure');
  const existing = res.getHeader('set-cookie');
  const all = Array.isArray(existing) ? [...existing] : typeof existing === 'string' ? [existing] : [];
  all.push(parts.join('; '));
  res.setHeader('set-cookie', all);
}

export function redirect(res: ServerResponse, location: string): void {
  // 302 + no-store: the ticket-bearing location must never be cached or revalidated.
  res.writeHead(302, { location, 'cache-control': 'no-store', 'content-type': 'text/plain' });
  res.end('redirecting');
}

export function sendText(res: ServerResponse, code: number, text: string): void {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

export function sendJson(res: ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(value));
}

// ------------------------------------------------------------------- server

export function createHttpServer(
  status: () => StatusSnapshot,
  metricsOpts: MetricsOptions,
  extraRoutes?: HttpRoute,
): Server {
  const metricsOn = metricsOpts.enabled && metricsOpts.token !== '';
  return createServer((req, res) => {
    // A base is required to parse a request-target; the host is never used.
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://server.invalid');
    } catch {
      sendText(res, 400, 'bad request');
      return;
    }
    const path = url.pathname;
    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.method === 'GET' && path === '/status') {
      // Public by design (launchers poll it cross-origin); read-only and cheap.
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(status()));
      return;
    }
    if (req.method === 'GET' && path === '/metrics' && metricsOn) {
      if (!bearerOk(req.headers.authorization, metricsOpts.token)) {
        res.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Bearer' });
        res.end('unauthorized');
        return;
      }
      // No CORS header: this is a scraper endpoint, never a browser one.
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(renderMetrics());
      return;
    }
    if (extraRoutes) {
      let handled: boolean | Promise<boolean>;
      try {
        handled = extraRoutes(req, res, url);
      } catch (err) {
        log('error', 'http.route_threw', { path, error: String(err) });
        if (!res.headersSent) sendText(res, 500, 'internal error');
        return;
      }
      if (handled === true) return;
      if (handled !== false) {
        void handled.then(
          (done) => {
            if (done) return;
            if (!res.headersSent) sendText(res, 404, 'not found');
          },
          (err) => {
            // Never swallow: an auth route failing silently would look like a hung login.
            log('error', 'http.route_rejected', { path, error: String(err) });
            if (!res.headersSent) sendText(res, 500, 'internal error');
            else res.end();
          },
        );
        return;
      }
    }
    // /ws upgrades never reach here; everything else is not ours.
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
}
