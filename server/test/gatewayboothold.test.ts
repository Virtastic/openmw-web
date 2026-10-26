// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// A DIAL TO A WORLD THAT IS STILL STARTING IS HELD, NOT REFUSED.
//
// 2026-10-26: the launcher starts a world and navigates at once; a cached engine dialled before
// the world listened, the gateway 502'd it instantly, the client went round its reconnect
// ladder over a game that was already rendering ("Waking the server"), and the second refusal
// ended as "sign-in was refused". The gateway now holds the socket until the world is up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { connect, createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { WorldSupervisor } from '../src/gateway/worlds';
import { startDirectory } from '../src/gateway/directory';

class FakeChild extends EventEmitter {
  pid = 99;
  kill(sig: string): boolean { queueMicrotask(() => this.emit('exit', 0, sig)); return true; }
}

async function harness(bootHoldMs: number) {
  const wdir = mkdtempSync(join(tmpdir(), 'omw-boothold-'));
  let listening = false; // the fake world answers /status only once this flips
  const worlds = new WorldSupervisor({
    settings: {
      worldsDir: wdir, gatewayPort: 8080, serverEntry: '/fake/server.mjs', nodeBin: '/fake/node',
      basePort: 43100, maxWorlds: 8, idleReapMs: 60_000, startTimeoutMs: 1000, restartBackoffMs: 1000,
      sharedDir: mkdtempSync(join(tmpdir(), 'omw-shared-')),
    },
    spawner: () => new FakeChild() as unknown as ChildProcess,
    fetchStatus: async () => (listening ? { playerCount: 0, connectedCount: 0, maxPlayers: 32, name: 'w' } : null),
  });
  const dir = await startDirectory({
    worlds, host: '127.0.0.1', port: 0, maxPerOwner: 4, worldsDir: wdir, bootHoldMs,
    resolveAccount: (auth: string) => (auth.startsWith('Bearer ') ? auth.slice(7) : undefined),
  });
  const id = 'priv-alice-abcd1234';
  const r = await fetch(`http://127.0.0.1:${dir.port}/worlds`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer alice' },
    body: JSON.stringify({ id, mode: 'private' }),
  });
  assert.equal(r.status, 200, await r.text());
  assert.equal(worlds.get(id)?.up, false, 'the world must start out not up');
  return { worlds, dir, id, goUp: () => { listening = true; },
    cleanup: async () => { await dir.close(); worlds.stopAll(); } };
}

/** First bytes back from a raw upgrade to /w/<id>, with when they came. */
function dial(port: number, path: string): Promise<{ got: string; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port }, () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let got = '';
    const done = (): void => { sock.destroy(); resolve({ got, ms: Date.now() - t0 }); };
    sock.on('data', (b) => { got += b.toString(); done(); });
    sock.on('error', done);
    sock.on('close', done);
    setTimeout(done, 5000).unref();
  });
}

test('a dial to a booting world is held, then spliced once the world is up', async () => {
  const h = await harness(5000);
  // The world's own listener: it answers the replayed handshake.
  const upstream = createServer((s) => s.once('data', (b) => {
    s.end(/^GET \/ws /.test(b.toString()) ? 'HTTP/1.1 101 Switching Protocols\r\n\r\n' : 'bad');
  }));
  await new Promise<void>((r) => upstream.listen(h.worlds.get(h.id)!.port, '127.0.0.1', r));
  try {
    const pending = dial(h.dir.port, `/w/${h.id}`);
    setTimeout(h.goUp, 600);
    const { got, ms } = await pending;
    assert.match(got, /101 Switching Protocols/, `the held dial must reach the world, got ${JSON.stringify(got)}`);
    assert.ok(ms >= 500, `answered after ${ms} ms, before the world was up`);
  } finally {
    upstream.close();
    await h.cleanup();
  }
});

test('a world that never comes up still fails the dial, after the hold', async () => {
  const h = await harness(400);
  try {
    const { got } = await dial(h.dir.port, `/w/${h.id}`);
    assert.match(got, /502/, 'the client retry ladder can only run if the dial fails');
  } finally {
    await h.cleanup();
  }
});

test('an unknown world is still refused at once', async () => {
  const h = await harness(5000);
  try {
    const { got, ms } = await dial(h.dir.port, '/w/priv-nobody-00000000');
    assert.match(got, /502/);
    assert.ok(ms < 1000, `took ${ms} ms`);
  } finally {
    await h.cleanup();
  }
});
