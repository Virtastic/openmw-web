// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// THE ONE WORLD COMES BACK ON DIAL (OT3-28).
//
// After a crash or an operator stop, the next /w/vvardenfell dial restarts it. Any other id is
// not a world and is never started, so a dial cannot make the gateway spawn a process for a
// name it invents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { WORLD_ID, WorldSupervisor } from '../src/gateway/worlds';
import { startDirectory } from '../src/gateway/directory';

class FakeChild extends EventEmitter {
  pid = 99;
  kill(sig: string): boolean { queueMicrotask(() => this.emit('exit', 0, sig)); return true; }
}

async function harness() {
  const wdir = mkdtempSync(join(tmpdir(), 'omw-revive-'));
  const worlds = new WorldSupervisor({
    settings: {
      worldsDir: wdir, gatewayPort: 8080,
      serverEntry: '/fake/server.mjs', nodeBin: '/fake/node',
      basePort: 43000, maxWorlds: 8, startTimeoutMs: 1000,
      restartBackoffMs: 1000,
      sharedDir: mkdtempSync(join(tmpdir(), 'omw-shared-')),
    },
    spawner: () => new FakeChild() as unknown as ChildProcess,
    fetchStatus: async (port) => ({ playerCount: 0, connectedCount: 0, maxPlayers: 32, name: `w${port}` }),
  });
  const dir = await startDirectory({
    worlds, host: '127.0.0.1', port: 0, 
    resolveAccount: (auth: string) => (auth.startsWith('Bearer ') ? auth.slice(7) : undefined),
  });
  return { worlds, dir, wdir, base: `http://127.0.0.1:${dir.port}`,
    cleanup: async () => { await dir.close(); worlds.stopAll(); } };
}

/** A raw WebSocket upgrade, which is the only way a browser reaches /w/<id>. Resolves on the
 *  first bytes back (a 502 when the world is refused, or the spliced handshake when it is not). */
function dial(port: number, path: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port }, () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let got = '';
    const done = (): void => { sock.destroy(); resolve(got); };
    sock.on('data', (b) => { got += b.toString(); done(); });
    sock.on('error', done);
    setTimeout(done, 1500).unref();
  });
}

test('the world, stopped, is started again by the next dial', async () => {
  const h = await harness();
  try {
    assert.ok(h.worlds.ensure(WORLD_ID));
    h.worlds.stop(WORLD_ID);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.worlds.get(WORLD_ID), undefined, 'world should be stopped');
    await dial(h.dir.port, `/w/${WORLD_ID}`);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(h.worlds.get(WORLD_ID), 'a dial did not bring the world back');
  } finally {
    await h.cleanup();
  }
});

test('a dial for any other id starts nothing', async () => {
  const h = await harness();
  try {
    const id = 'priv-mallory-deadbeef';
    mkdirSync(join(h.wdir, id), { recursive: true });
    const res = await dial(h.dir.port, `/w/${id}`);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.worlds.running, 0, 'a dial spawned a world that is not the world');
    assert.match(res, /502/, 'the dial must fail so the client retry ladder can run');
  } finally {
    await h.cleanup();
  }
});
