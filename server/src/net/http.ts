// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Plain HTTP endpoints on the same server the WSS attaches to:
// /healthz -> "ok", /status -> public JSON snapshot.

import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { renderMetrics } from '../metrics';

// M8 lobby payload: everything a launcher needs to list a server and offer join-by-URL,
// and NOTHING more. Deliberately absent: IP addresses, account names (the `name` here is
// the in-game display name a player chose to show to every other player anyway), ranks,
// bans, and any per-player identifier beyond the transient session playerId.
export interface StatusSnapshot {
  name: string;
  motd: string;
  players: { id: number; name: string; cellKey: string | null; level?: number }[];
  playerCount: number;
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

function bearerOk(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const got = Buffer.from(header.slice(7));
  const want = Buffer.from(token);
  // Length is compared separately because timingSafeEqual throws on a mismatch; token
  // length is not the secret.
  return got.length === want.length && timingSafeEqual(got, want);
}

export function createHttpServer(status: () => StatusSnapshot, metricsOpts: MetricsOptions): Server {
  const metricsOn = metricsOpts.enabled && metricsOpts.token !== '';
  return createServer((req, res) => {
    const url = req.url?.split('?')[0];
    if (req.method === 'GET' && url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.method === 'GET' && url === '/status') {
      // Public by design (launchers poll it cross-origin); read-only and cheap.
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(status()));
      return;
    }
    if (req.method === 'GET' && url === '/metrics' && metricsOn) {
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
    // /ws upgrades never reach here; everything else is not ours.
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
}
