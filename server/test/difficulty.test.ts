// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-88: [rules].difficulty is pushed to every client AND the sim peer in SessionWelcome; the
// engine (MWMP::effectiveDifficulty) applies it in place of the local slider.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const PEER_PASS = 'peer-secret-1';

async function boot(t: { after(fn: () => unknown): void }, difficulty: number) {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS }, limits: { maxConnsPerIp: 16 }, rules: { difficulty } },
  });
  t.after(() => server.close());
  return server;
}

function flags(w: Record<string, unknown>): Record<string, unknown> {
  return w['flags'] as Record<string, unknown>;
}

test('the server difficulty reaches both a player and the sim peer', async (t) => {
  const server = await boot(t, 75);
  const peer = await TestClient.connect(server.port);
  t.after(() => peer.close());
  peer.system = true;
  peer.hello();
  await peer.waitJson('SessionHelloOk');
  peer.sendJson({ t: 'SessionRegister', account: 'simpeer-world', password: PEER_PASS, serverPassword: PEER_PASS });
  const pw = await peer.waitJson('SessionWelcome');
  assert.equal(flags(pw)['difficulty'], 75, 'the peer scales the bodies it rules with the server value');

  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  const { welcome } = await a.joinAsNew('Hardmode');
  assert.equal(flags(welcome)['difficulty'], 75, 'the client gets the same value');
});

test('an out-of-range difficulty is clamped to the engine slider range', async (t) => {
  const server = await boot(t, 9000.4);
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  const { welcome } = await a.joinAsNew('Clamped');
  assert.equal(flags(welcome)['difficulty'], 500);
});
