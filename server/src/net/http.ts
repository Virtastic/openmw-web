// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Plain HTTP endpoints on the same server the WSS attaches to:
// /healthz -> "ok", /status -> public JSON snapshot.

import { createServer, type Server } from 'node:http';

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

export function createHttpServer(status: () => StatusSnapshot): Server {
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
    // /ws upgrades never reach here; everything else is not ours.
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
}
