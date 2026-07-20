// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Plain HTTP endpoints on the same server the WSS attaches to:
// /healthz -> "ok", /status -> public JSON snapshot.

import { createServer, type Server } from 'node:http';

export interface StatusSnapshot {
  name: string;
  players: { id: number; name: string; cellKey: string | null }[];
  maxPlayers: number;
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
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status()));
      return;
    }
    // /ws upgrades never reach here; everything else is not ours.
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
}
