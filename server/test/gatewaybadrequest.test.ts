// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// ONE BAD REQUEST DOES NOT END THE GATEWAY. Prod 2026-10-14 21:42: a request whose URL `new URL`
// could not parse threw in the directory's handler -- an uncaughtException, the whole crash
// shutdown, every world offline (502) until a manual restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { WorldSupervisor } from '../src/gateway/worlds';
import { startDirectory } from '../src/gateway/directory';

class FakeChild extends EventEmitter {
  pid = 42;
  kill(sig: string): boolean { queueMicrotask(() => this.emit('exit', 0, sig)); return true; }
}

function raw(port: number, head: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1', () => s.write(head));
    let buf = '';
    s.on('data', (d) => { buf += d; });
    s.on('end', () => resolve(buf));
    s.on('error', reject);
    setTimeout(() => { s.destroy(); resolve(buf); }, 2000);
  });
}

test('a request whose URL cannot be parsed gets a 400, and the gateway keeps serving', async (t) => {
  const wdir = mkdtempSync(join(tmpdir(), 'omw-gwbad-'));
  const worlds = new WorldSupervisor({
    settings: {
      worldsDir: wdir, gatewayPort: 8080, serverEntry: '/fake/s.mjs', nodeBin: '/fake/node',
      basePort: 43100, maxWorlds: 4, idleReapMs: 60_000, startTimeoutMs: 1000,
      restartBackoffMs: 1000, sharedDir: mkdtempSync(join(tmpdir(), 'omw-gwbad-shared-')),
    },
    spawner: () => new FakeChild() as unknown as ChildProcess,
    fetchStatus: async () => ({ playerCount: 0, connectedCount: 0, maxPlayers: 32, name: 'w' }),
  });
  const dir = await startDirectory({ worlds, host: '127.0.0.1', port: 0, maxPerOwner: 4, worldsDir: wdir });
  t.after(async () => { await dir.close(); worlds.stopAll(); });

  const crashed: unknown[] = [];
  const onCrash = (e: unknown): void => { crashed.push(e); };
  process.on('uncaughtException', onCrash);
  t.after(() => process.off('uncaughtException', onCrash));

  // Unparseable against the base: a bad Host header.
  const reply = await raw(dir.port, 'GET /worlds HTTP/1.1\r\nHost: bad host[\r\nConnection: close\r\n\r\n');
  assert.match(reply, /^HTTP\/1\.1 400/, `expected a 400, got: ${reply.slice(0, 80)}`);
  assert.deepEqual(crashed, [], 'nothing escaped the handler');

  const ok = await fetch(`http://127.0.0.1:${dir.port}/clientlog`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'x', lines: [] }),
  });
  assert.equal(ok.status, 204, 'the next request is served as usual');
});
