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
  // SIM PEERS THIS WORLD IS RUNNING. One engine per OCCUPIED CELL, so this is not a constant
  // per world -- it is the number that actually spends the host's RAM, at roughly 487 MB each.
  // The gateway's memory governor budgets on it; see gateway/worlds.ts capacity(). Reported
  // even when it is 1 or 0, because a governor that has to guess is the bug it was written for.
  peerCount: number;
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

// Set by the gateway when it splices a client through to a world (gateway/directory.ts). The
// gateway strips any client-supplied copy before stamping its own.
export const CLIENT_IP_HEADER = 'x-omw-client-ip';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// THE TRUST BOUNDARY FOR EVERY FORWARDED-FOR HEADER. A reverse proxy is the only way a request
// reaches us in production (deploy/openmw-mp.caddy publishes no host ports), and a proxy always
// sits on a private network: loopback on a bare host, a docker bridge in the compose deploy. So
// a forwarding header is trustworthy exactly when the PEER is private. A client on the public
// internet that reaches the origin directly has a public peer address, and every address header
// it sends is ignored.
//
// This is what makes the headers safe to read at all. Trusting cf-connecting-ip from any peer
// (which is what this used to do) let a client pick its own address: evading IP bans and
// maxConnsPerIp, and attributing its failed logins to a victim's address to lock THEM out.
function proxyIsTrusted(peer: string): boolean {
  return isPrivateAddress(peer);
}

/**
 * Is this address on the same machine or the same private network?
 *
 * Used for the trusted-proxy boundary above, and by first-run setup to tell "the person who
 * just started this server" from "whoever found it on the internet". Those are the same
 * question — can this address only exist on the near side of a router — so they share one
 * definition rather than two that could drift apart.
 *
 * Note this must be given a REAL client address, i.e. the output of clientIp(), not the raw
 * socket peer. Behind the bundled Caddy every socket peer is the proxy's own private address,
 * so testing the peer would answer "private" for the entire internet.
 */
export function isPrivateAddress(addr: string): boolean {
  if (LOOPBACK.has(addr)) return true;
  const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  if (/^(10|127)\./.test(v4)) return true;
  if (/^192\.168\./.test(v4)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(v4)) return true;
  if (/^169\.254\./.test(v4)) return true;   // link-local, e.g. a direct cable
  if (/^f[cd]/i.test(addr)) return true;      // fc00::/7 unique-local
  return /^fe80:/i.test(addr);                // IPv6 link-local
}

// Set once at boot from [limits] trustCloudflareIp. A module-level switch rather than a
// threaded parameter because clientIp is called from a dozen places that have no config in
// hand, and the answer is a property of the DEPLOYMENT, not of the request.
let trustCloudflareIp = false;

/** Declare that Cloudflare terminates in front of us and the edge strips client copies of
 *  CF-Connecting-IP. Called once at boot; never per request. */
export function setTrustCloudflareIp(trust: boolean): void {
  trustCloudflareIp = trust;
  warnedCloudflare = false;
}

// One-shot, because this fires on a request path.
let warnedCloudflare = false;

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === 'string' && first.length > 0 ? first : undefined;
}

// The address to rate-limit, ban and log by.
//
// This used to return `req.socket.remoteAddress` bare. Behind Caddy that is the PROXY for every
// request, so `loginPerMinPerIp` (5) was one bucket for the entire server: the sixth person to
// click "sign in" in any given minute was refused, and stayed refused. Every caller in
// src/auth/routes.ts keys its limiter on this.
export function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? '';
  // LOOPBACK, not merely private. The gateway splices a client through to a world over
  // 127.0.0.1 and stamps this header itself, so loopback is the only place it can legitimately
  // come from. Accepting it from any private address — which is what this briefly did — let a
  // client send its own copy through the reverse proxy and be believed, because the proxy
  // forwards request headers untouched and the proxy IS a private peer. Confirmed against the
  // live deployment: a forged header bought a fresh login-rate budget on demand.
  //
  // The edge now deletes client-supplied copies too (deploy/Caddyfile). Both halves are kept:
  // the proxy is the authority on who the client is, and this is the narrowest rule that still
  // lets the gateway do its job.
  if (LOOPBACK.has(peer)) {
    const stamped = header(req, CLIENT_IP_HEADER);
    if (stamped) return stamped;
  }
  if (!proxyIsTrusted(peer)) return peer;
  // Cloudflare's header, and OFF unless a deployment says Cloudflare is really in front. It
  // only means anything when the edge also deletes any copy the client sent — "the peer is
  // private" proves the header survived the hop, never that the hop wrote it. Verified by
  // probing the gateway directly from inside the docker network, past the edge: with this
  // ungated, a forged CF-Connecting-IP bought a fresh login budget while the control stayed
  // refused. Where Cloudflare is NOT in front, this header is pure attack surface, so the
  // default is to ignore it.
  if (trustCloudflareIp) {
    const cf = header(req, 'cf-connecting-ip');
    if (cf) return cf;
  } else if (!warnedCloudflare && header(req, 'cf-connecting-ip') !== undefined) {
    // THE DANGEROUS DIRECTION, MADE VISIBLE. Off behind Cloudflare is silent: every player
    // resolves to the edge's address, so per-IP limits quietly become one global bucket and
    // the sixth person to sign in within a minute is refused — the exact fault this sweep
    // began by fixing. Cloudflare really being in front is the only way this header arrives
    // from a trusted proxy, so seeing one here says the setting is probably wrong.
    warnedCloudflare = true;
    log('warn', 'net.cloudflare_header_ignored', {
      note: 'CF-Connecting-IP arrived from a trusted proxy but [limits] trustCloudflareIp is '
        + 'false, so every client resolves to the proxy and per-IP limits are effectively '
        + 'global. Set it true if Cloudflare terminates in front of this deployment.',
    });
  }
  // LAST entry, not first. A proxy APPENDS the peer it saw, so anything a client put in the
  // header itself stays to the left of the entry our own proxy added. Taking [0] — which
  // data/locker-routes.ts did — reads the client's forgery by preference.
  const xff = header(req, 'x-forwarded-for');
  if (xff) {
    const last = xff.split(',').pop()?.trim();
    if (last) return last;
  }
  return peer;
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

// Bounds for /clientlog. Generous enough for a real burst of engine warnings on a bad boot,
// small enough that the endpoint cannot be used as storage or a flood vector.
const MAX_CLIENT_LOG_BYTES = 256 * 1024;
const MAX_CLIENT_LOG_LINES = 500;
const MAX_CLIENT_LOG_LINE = 2000;
// Per-IP budget: a token bucket refilling at ~1 batch/sec with a burst of 20. A client shipping
// on a 5 s timer never notices; something looping does.
const CLIENT_LOG_BURST = 20;
const clientLogBuckets = new Map<string, { tokens: number; at: number }>();

function clientLogAllowed(ip: string): boolean {
  const now = Date.now();
  const b = clientLogBuckets.get(ip) ?? { tokens: CLIENT_LOG_BURST, at: now };
  b.tokens = Math.min(CLIENT_LOG_BURST, b.tokens + (now - b.at) / 1000);
  b.at = now;
  if (b.tokens < 1) { clientLogBuckets.set(ip, b); return false; }
  b.tokens -= 1;
  clientLogBuckets.set(ip, b);
  // Bounded: without this the map is a slow memory leak keyed by attacker-controlled IPs.
  if (clientLogBuckets.size > 4096) {
    for (const [k, v] of clientLogBuckets) if (now - v.at > 60_000) clientLogBuckets.delete(k);
  }
  return true;
}

export function createHttpServer(
  status: () => StatusSnapshot,
  metricsOpts: MetricsOptions,
  extraRoutes?: HttpRoute,
  /** Reasons this server cannot host a world yet; empty means healthy. See /healthz. */
  notReady?: () => string[],
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
      // A server in setup mode is RUNNING but cannot host a world, so it must not answer
      // "ok" — a container that reports itself healthy while turning every player away is
      // exactly the silent failure the old boot-time refusal existed to prevent. 503 keeps
      // the process alive (so the operator can fix it in the dashboard) while still failing
      // the Docker healthcheck and any monitor watching this endpoint.
      const blockers = notReady?.() ?? [];
      if (blockers.length > 0) {
        // The reasons name filesystem paths and configuration keys, and this endpoint is
        // reachable from the internet on the shipped self-host topology. A container
        // healthcheck only reads the status code, and the dashboard reads the detail through
        // its own authenticated route — so anonymous callers get the status and nothing else.
        sendText(res, 503, 'not ready\n');
        return;
      }
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
    // CLIENT LOGS, INTO THE SAME STREAM AS EVERYTHING ELSE.
    //
    // Every client-side fault this project has chased was invisible from the server: a Lua
    // handler that threw and silently disabled a subsystem, a double loading overlay, an
    // OpenAL enum error, a WebGL warning. They were only ever found by someone watching their
    // own console, which does not scale past one person and leaves nothing to read afterwards.
    // Server events already land in journald as structured JSON; this puts client events beside
    // them so one query covers both halves of the conversation.
    //
    // Deliberately unauthenticated, because the most valuable reports come from a client that
    // FAILED TO JOIN and therefore has no session to authenticate with. That makes it an open
    // POST endpoint on the public internet, so it is bounded on every axis that matters:
    // body size, line count, line length, and a per-IP rate limit. Nothing here is trusted --
    // it is recorded as `client.log` with the reporting IP, never interpreted.
    if (req.method === 'POST' && path === '/clientlog') {
      res.setHeader('access-control-allow-origin', '*');
      // clientIp, not the raw socket: behind the reverse proxy every request has the PROXY's
      // address, so a raw-socket bucket would be one shared budget for the whole internet --
      // the same bug that once made loginPerMinPerIp refuse the sixth person to sign in.
      const ip = clientIp(req);
      if (!clientLogAllowed(ip)) {
        // 429 rather than a silent drop: a client shipping too fast should back off, and a
        // silent success would have it keep going forever.
        sendText(res, 429, 'slow down');
        return;
      }
      let body = '';
      let tooBig = false;
      req.on('data', (chunk: Buffer) => {
        if (tooBig) return;
        body += chunk.toString('utf8');
        if (body.length > MAX_CLIENT_LOG_BYTES) { tooBig = true; body = ''; }
      });
      req.on('end', () => {
        if (tooBig) { sendText(res, 413, 'too large'); return; }
        let lines: unknown;
        let session = '';
        try {
          const parsed = JSON.parse(body) as { lines?: unknown; session?: unknown };
          lines = parsed.lines;
          session = typeof parsed.session === 'string' ? parsed.session.slice(0, 64) : '';
        } catch { sendText(res, 400, 'bad json'); return; }
        if (!Array.isArray(lines)) { sendText(res, 400, 'lines must be an array'); return; }
        for (const raw of lines.slice(0, MAX_CLIENT_LOG_LINES)) {
          if (typeof raw !== 'string') continue;
          const text = raw.slice(0, MAX_CLIENT_LOG_LINE);
          // Level is INFERRED here rather than taken from the client: a caller could otherwise
          // mark everything 'error' and drown the operator's real alerts.
          const level = /error|ABORT|fatal/i.test(text) ? 'error'
            : /warn/i.test(text) ? 'warn' : 'info';
          log(level, 'client.log', { ip, session, text });
        }
        res.writeHead(204);
        res.end();
      });
      return;
    }
    if (req.method === 'OPTIONS' && path === '/clientlog') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      res.end();
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
