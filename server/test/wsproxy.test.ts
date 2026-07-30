// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Worlds are reachable through ONE port. Each world is its own process on its own port, and
// production publishes none of them — the edge reaches only the gateway (deploy/
// openmw-mp.caddy: `reverse_proxy openmw-mp:8080`), so before this the multi-world
// architecture simply did not work outside local dev.
//
// Clients dial /w/<worldId> on the gateway and get spliced through to the world's loopback
// port. A raw socket pipe, so this test drives it with a real WebSocket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startDirectory } from '../src/gateway/directory';
import { WorldSupervisor } from '../src/gateway/worlds';
import { startServer } from '../src/server';
import { tmpDataDir, MANIFEST } from './helpers';
import { SUBPROTOCOL } from '../src/net/ws';

test('a world is reachable through the gateway port, and a missing one fails fast', async (t) => {
  const dataDir = tmpDataDir();
  const world = await startServer({ dataDir, port: 0, host: '127.0.0.1', worldId: 'w1' });
  t.after(() => world.close());

  // A supervisor that reports our already-running world rather than spawning one.
  const worlds = {
    get: (id: string) => (id === 'w1'
      ? { id: 'w1', mode: 'public', name: 'w1', port: world.port, playerCount: 0, maxPlayers: 8, up: true }
      : undefined),
    list: () => [],
  } as unknown as WorldSupervisor;

  const dir = await startDirectory({
    worlds, host: '127.0.0.1', port: 0, publicHost: '127.0.0.1',
  } as never);
  t.after(() => dir.close?.());

  // Through the gateway port, not the world's.
  // The CLIENT speaks first in this protocol, so say hello and expect the ack back.
  // The world enforces a subprotocol, and the proxy forwards headers verbatim — so the
  // client must offer it exactly as it would on a direct connection.
  const ws = new WebSocket(`ws://127.0.0.1:${dir.port}/w/w1`, [SUBPROTOCOL]);
  const hello = await new Promise<string>((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({
      t: 'SessionHello', proto: 1, engineHash: 'abcdef123456', lserVersion: 0,
      manifest: MANIFEST, simulatesActors: false })));
    ws.on('message', (d) => resolve(String(d)));
    ws.on('close', (c, r) => reject(new Error(`closed ${c} ${String(r)}`)));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('no reply through the proxy')), 8000);
  });
  assert.match(hello, /SessionHelloOk|SessionDisconnect|serverName/i,
    'the world did not answer through the gateway: ' + hello.slice(0, 200));
  ws.close();

  // An unknown world must CLOSE, not hang — the client's retry ladder needs the socket to end.
  const dead = new WebSocket(`ws://127.0.0.1:${dir.port}/w/nosuchworld`, [SUBPROTOCOL]);
  await new Promise<void>((resolve, reject) => {
    dead.on('error', () => resolve());   // 502 handshake failure surfaces as an error
    dead.on('close', () => resolve());
    dead.on('open', () => reject(new Error('an unknown world accepted a connection')));
    setTimeout(() => reject(new Error('unknown world hung instead of failing')), 6000);
  });
});
