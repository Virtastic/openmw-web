// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// WebSocket layer: subprotocol enforcement, permessage-deflate, protocol-level ping
// keepalive (2 missed pongs -> drop), client IP extraction (Cloudflare-aware).

import type { Server, IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { log } from '../log';

// PROTOCOL.md says "omw-mp/1", but "/" is not an RFC 6455 token character: the browser
// WebSocket constructor (and Node's undici/ws clients) throw SyntaxError before any I/O.
// The shippable token is "omw-mp.1"; the raw header form "omw-mp/1" is still accepted
// for non-WHATWG clients. Flagged for a PROTOCOL.md amendment.
export const SUBPROTOCOL = 'omw-mp.1';
export const SUBPROTOCOL_LEGACY = 'omw-mp/1';
const PING_INTERVAL_MS = 25_000;
const MAX_MISSED_PONGS = 2;

export function clientIp(req: IncomingMessage): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.length > 0) return cf;
  if (Array.isArray(cf) && cf[0]) return cf[0];
  return req.socket.remoteAddress ?? 'unknown';
}

export function attachWss(
  httpServer: Server,
  maxMsgBytes: number,
  onSocket: (ws: WebSocket, ip: string) => void,
): WebSocketServer {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    handleProtocols: (protocols) =>
      protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : protocols.has(SUBPROTOCOL_LEGACY) ? SUBPROTOCOL_LEGACY : false,
    maxPayload: maxMsgBytes,
    perMessageDeflate: {
      threshold: 512,
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
    },
  });

  const missedPongs = new Map<WebSocket, number>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const missed = missedPongs.get(ws) ?? 0;
      if (missed >= MAX_MISSED_PONGS) {
        log('info', 'ws.pong_timeout_drop', {});
        ws.terminate();
        continue;
      }
      missedPongs.set(ws, missed + 1);
      ws.ping();
    }
  }, PING_INTERVAL_MS);
  heartbeat.unref();

  wss.on('connection', (ws, req) => {
    // handleProtocols only runs when the client offers protocols; a client offering
    // none is accepted by ws with an empty protocol — PROTOCOL.md says reject.
    if (ws.protocol !== SUBPROTOCOL && ws.protocol !== SUBPROTOCOL_LEGACY) {
      log('info', 'ws.no_subprotocol_refused', { ip: clientIp(req) });
      ws.close(1002, 'subprotocol required');
      return;
    }
    missedPongs.set(ws, 0);
    ws.on('pong', () => missedPongs.set(ws, 0));
    ws.on('close', () => missedPongs.delete(ws));
    onSocket(ws, clientIp(req));
  });
  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}
