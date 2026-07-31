// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The sim peer authenticates with [server].password, carried in its OWN field
// (serverPassword) — distinct from the user password. The client Lua never sent that field,
// so the gate compared '' against the configured secret and refused every peer with "wrong
// server password". The peer booted, loaded the world, failed auth and sat there burning a
// core: server-authoritative NPC simulation was never actually running, and nothing showed
// it because readiness was signalled at HELLO, before auth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const PASS = 'peer-secret-1';

test('a system peer is admitted with the server password, and refused without it', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false,
    dataDir, port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PASS }, login: { allowHarnessAuth: true } },
  });
  t.after(() => server.close());

  // No serverPassword: refused. This is the state every peer was in.
  const bad = await TestClient.connect(server.port);
  bad.system = true;
  bad.hello();
  await bad.waitJson('SessionHelloOk');
  bad.sendJson({ t: 'SessionLoginRequest', account: 'simpeer-world', password: PASS });
  const refused = await bad.waitJson('SessionDisconnect');
  assert.match(String((refused as { detail?: string }).detail ?? ''), /server password/);

  // With it: admitted.
  const good = await TestClient.connect(server.port);
  good.system = true;
  good.hello();
  await good.waitJson('SessionHelloOk');
  // The real ladder registers on first sight, then logs in. systemAuthAllowed() exempts a
  // password-authenticated peer from the SSO-only gate, which is what makes this possible.
  good.sendJson({ t: 'SessionRegister', account: 'simpeer-world', password: PASS, serverPassword: PASS });
  const res = await Promise.race([
    good.waitJson('SessionWelcome').then((m) => ({ ok: true, m })),
    good.waitJson('SessionDisconnect').then((m) => ({ ok: false, m })),
  ]);
  assert.equal(res.ok, true, 'admitted, got: ' + JSON.stringify(res.m));
});
