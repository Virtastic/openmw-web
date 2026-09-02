// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// WebSocket layer: subprotocol enforcement, permessage-deflate, protocol-level ping
// keepalive (2 missed pongs -> drop), client IP extraction (Cloudflare-aware).

import type { Server, IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { log } from '../log';
import { metrics } from '../metrics';

// PROTOCOL.md says "omw-mp/2", but "/" is not an RFC 6455 token character: the browser
// WebSocket constructor (and Node's undici/ws clients) throw SyntaxError before any I/O.
// The shippable token is "omw-mp.2"; the raw header form "omw-mp/2" is still accepted
// for non-WHATWG clients. Flagged for a PROTOCOL.md amendment.
export const SUBPROTOCOL = 'omw-mp.2';
export const SUBPROTOCOL_LEGACY = 'omw-mp/2';
// Keepalive deadline, unchanged in effect: a socket that has not ponged for this long is
// dead. Expressed as a deadline rather than a missed-pong count because the probe interval
// below is now independent of it.
const PONG_DEADLINE_MS = 25_000 * 2;
// Every ping carries a monotonic stamp the client echoes in its pong, so the RTT is the
// server's OWN measurement — the only latency number that cannot be forged by a modified
// client (M4 authority election runs off it). 5 s rather than the old 25 s because a
// degradation gate needs several samples inside its sustain window; the cost is 2 control
// frames (~14 bytes on the wire) per socket per 5 s — under 6 B/s/player, ~0.4 KB/s at 64
// players, which is noise next to a single pose batch.
const DEFAULT_PROBE_MS = 5_000;

interface SocketRtt {
  rttMs?: number;
  lastPongAt: number;
}
const rttState = new WeakMap<WebSocket, SocketRtt>();

// Last measured round-trip for a socket, undefined until the first pong.
export function socketRttMs(ws: WebSocket): number | undefined {
  return rttState.get(ws)?.rttMs;
}

// ONE implementation, in net/http.ts. There used to be three — this one, http.ts's (which read
// the raw socket peer and so made the login rate limit global), and a third in
// data/locker-routes.ts that trusted x-forwarded-for[0] from anybody. Re-exported rather than
// moved so every existing `from '../net/ws'` import keeps working.
import { clientIp, CLIENT_IP_HEADER } from './http';
export { clientIp, CLIENT_IP_HEADER };

export function attachWss(
  httpServer: Server,
  maxMsgBytes: number,
  onSocket: (ws: WebSocket, ip: string) => void,
  probeIntervalMs = DEFAULT_PROBE_MS,
): WebSocketServer {
  const probeMs =
    Number.isFinite(probeIntervalMs) && probeIntervalMs >= 1_000 ? probeIntervalMs : DEFAULT_PROBE_MS;
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

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const ws of wss.clients) {
      const st = rttState.get(ws);
      if (st && now - st.lastPongAt > PONG_DEADLINE_MS) {
        log('info', 'ws.pong_timeout_drop', {});
        metrics.pongTimeouts.inc();
        ws.terminate();
        continue;
      }
      // performance.now() (not Date.now) so a wall-clock step cannot fabricate an RTT.
      // Fresh buffer per frame: `ws` may queue the payload past this tick.
      const stamp = Buffer.allocUnsafe(8);
      stamp.writeDoubleLE(performance.now(), 0);
      ws.ping(stamp);
    }
  }, probeMs);
  heartbeat.unref();

  wss.on('connection', (ws, req) => {
    // handleProtocols only runs when the client offers protocols; a client offering
    // none is accepted by ws with an empty protocol — PROTOCOL.md says reject.
    if (ws.protocol !== SUBPROTOCOL && ws.protocol !== SUBPROTOCOL_LEGACY) {
      log('info', 'ws.no_subprotocol_refused', { ip: clientIp(req) });
      metrics.connRefused.inc({ reason: 'no_subprotocol' });
      ws.close(1002, 'subprotocol required');
      return;
    }
    rttState.set(ws, { lastPongAt: Date.now() });
    ws.on('pong', (data: Buffer) => {
      const st = rttState.get(ws);
      if (!st) return;
      st.lastPongAt = Date.now();
      // A client that echoes garbage (or nothing) still counts as alive, it just yields no
      // RTT sample — warn+drop, never throw, and never fall back to a client-supplied value.
      if (data.length !== 8) return;
      const rtt = performance.now() - data.readDoubleLE(0);
      if (!Number.isFinite(rtt) || rtt < 0) return; // echoed stamp was not ours
      st.rttMs = rtt;
    });
    ws.on('close', () => rttState.delete(ws));
    onSocket(ws, clientIp(req));
  });
  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}
