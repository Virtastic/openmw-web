// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// `system` is a CLIENT-DECLARED flag in SessionHello, and it is the whole basis of "only the
// sim peer simulates NPCs". The gate on it used to be skipped entirely when [server].password
// was empty — the shipped default — so any ordinary registered client could send
// {system:true} and be believed, then be granted cell authority over every NPC in the world.
// An unset password is not permission: it means no peer can authenticate here at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

test('a client cannot declare itself a system peer when no server password is set', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false,
    dataDir, port: 0, host: '127.0.0.1',
    configOverride: { server: { password: '' }, login: { allowHarnessAuth: true } },
  });
  t.after(() => server.close());

  const spoof = await TestClient.connect(server.port);
  spoof.system = true;
  spoof.hello();
  await spoof.waitJson('SessionHelloOk');
  spoof.register('Impostor', 'hunter22');
  const refused = await spoof.waitJson('SessionDisconnect');
  assert.equal((refused as { code?: string }).code, 'AUTH_FAILED');
  assert.match(String((refused as { detail?: string }).detail ?? ''), /password/);
});

test('a real peer still authenticates when a password IS set', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false,
    dataDir, port: 0, host: '127.0.0.1',
    configOverride: { server: { password: 'peer-secret-1' }, login: { allowHarnessAuth: true } },
  });
  t.after(() => server.close());

  const peer = await TestClient.connect(server.port);
  peer.system = true;
  peer.hello();
  await peer.waitJson('SessionHelloOk');
  peer.sendJson({ t: 'SessionRegister', account: 'simpeer-world', password: 'peer-secret-1', serverPassword: 'peer-secret-1' });
  await peer.waitJson('SessionWelcome');
});
