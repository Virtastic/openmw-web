// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// H6: [admin] allowFrom keeps /admin off the internet on the multiplayer gateway.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { WorldSupervisor } from '../src/gateway/worlds';
import { startDirectory } from '../src/gateway/directory';
import { createServer } from 'node:http';
import { addressAllowed, gateAdmin } from '../src/net/http';

test('addressAllowed: exact addresses and IPv4 CIDRs', () => {
  assert.equal(addressAllowed('203.0.113.7', ['203.0.113.7']), true);
  assert.equal(addressAllowed('::ffff:10.1.2.3', ['10.0.0.0/8']), true);
  assert.equal(addressAllowed('192.168.1.130', ['192.168.1.0/24']), true);
  assert.equal(addressAllowed('192.168.2.1', ['192.168.1.0/24']), false);
  assert.equal(addressAllowed('8.8.8.8', ['0.0.0.0/0']), true);
  assert.equal(addressAllowed('8.8.8.8', ['garbage/8', '10.0.0.0/33']), false);
  assert.equal(addressAllowed('8.8.8.8', []), false);
});

async function gateway(t: test.TestContext, adminAllowFrom: string[]) {
  const wdir = mkdtempSync(join(tmpdir(), 'omw-adm-'));
  const worlds = new WorldSupervisor({
    settings: {
      worldsDir: wdir, gatewayPort: 8080, serverEntry: '/fake/server.mjs', nodeBin: '/fake/node',
      basePort: 42000, maxWorlds: 1, startTimeoutMs: 1000, restartBackoffMs: 1000,
      sharedDir: mkdtempSync(join(tmpdir(), 'omw-adm-shared-')),
    },
    spawner: () => { throw new Error('no worlds here'); },
    fetchStatus: async () => ({ playerCount: 0, connectedCount: 0, maxPlayers: 1, name: 'x' }),
  });
  const dir = await startDirectory({
    worlds, host: '127.0.0.1', port: 0, adminAllowFrom,
    admin: (_req, res) => { res.writeHead(200); res.end('dashboard'); return true; },
  });
  t.after(async () => { await dir.close(); worlds.stopAll(); });
  return `http://127.0.0.1:${dir.port}`;
}

test('H6: /admin answers 404 outside [admin] allowFrom, and only /admin is gated', async (t) => {
  const shut = await gateway(t, ['10.0.0.0/8']);
  assert.equal((await fetch(`${shut}/admin`)).status, 404);
  assert.equal((await fetch(`${shut}/admin/api/state`)).status, 404);
  assert.equal((await fetch(`${shut}/`)).status, 200, 'the front page is not the dashboard');

  const open = await gateway(t, ['127.0.0.1']);
  assert.equal((await fetch(`${open}/admin`)).status, 200);
  const unset = await gateway(t, []);
  assert.equal((await fetch(`${unset}/admin/api/state`)).status, 200, 'empty = no restriction');
});

test('H6: the single-world server gates /admin the same way', async (t) => {
  let allow: string[] = ['10.0.0.0/8'];
  const route = gateAdmin((_req, res) => { res.writeHead(200); res.end('dashboard'); return true; }, () => allow);
  const srv = createServer((req, res) => { void route(req, res, new URL(req.url!, 'http://x')); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  assert.equal((await fetch(`${base}/admin`)).status, 404);
  assert.equal((await fetch(`${base}/admin/api/state`)).status, 404);
  assert.equal((await fetch(`${base}/`)).status, 200, 'the front page is not the dashboard');
  allow = ['127.0.0.1'];
  assert.equal((await fetch(`${base}/admin`)).status, 200);
  allow = [];
  assert.equal((await fetch(`${base}/admin`)).status, 200, 'empty = no restriction');
});
