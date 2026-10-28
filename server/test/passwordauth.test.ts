// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// CL13: players sign in by SSO only. Account+password stays for the sim peer, the harness
// (allowHarnessAuth) and loopback (this suite), never a browser on a public address. The
// public client is modelled the way the gateway delivers one: over loopback with the real
// address stamped in x-omw-client-ip, which the world believes from loopback only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { CLIENT_IP_HEADER } from '../src/net/http';
import { TestClient, tmpDataDir } from './helpers';

const PASS = 'peer-secret-1';
const PUBLIC = { [CLIENT_IP_HEADER]: '203.0.113.5' };

async function boot(t: { after(fn: () => unknown): void }, allowHarnessAuth = false) {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PASS }, login: { allowHarnessAuth } },
  });
  t.after(() => server.close());
  return server;
}

async function refused(port: number, msg: Record<string, unknown>): Promise<unknown> {
  const c = await TestClient.connect(port, 'omw-mp.2', '/ws', PUBLIC);
  c.hello();
  await c.waitJson('SessionHelloOk');
  c.sendJson({ ...msg, serverPassword: PASS });
  const dc = await c.waitJson('SessionDisconnect');
  c.close();
  return dc['code'];
}

test('a public client offering a password is refused, register and login alike', async (t) => {
  const server = await boot(t);
  assert.equal(await refused(server.port, { t: 'SessionRegister', account: 'stranger', password: 'hunter22' }), 'AUTH_FAILED');
  // The account exists (made over loopback); the public login is still refused.
  const local = await TestClient.connect(server.port);
  await local.joinAsNew('Local', 'hunter22');
  local.close();
  assert.equal(await refused(server.port, { t: 'SessionLoginRequest', account: 'Local', password: 'hunter22' }), 'AUTH_FAILED');
});

test('the sim peer and a harness-opted server still take a password', async (t) => {
  const server = await boot(t);
  const peer = await TestClient.simPeer(server.port, PASS); // throws if refused
  t.after(() => peer.close());

  const harness = await boot(t, true);
  const c = await TestClient.connect(harness.port, 'omw-mp.2', '/ws', PUBLIC);
  t.after(() => c.close());
  await c.joinAsNew('Harness', 'hunter22'); // throws if refused
});
