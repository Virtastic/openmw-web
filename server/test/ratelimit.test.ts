// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Rate limiting: per-session message flood -> RATE disconnect; per-IP connection cap.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

test('rate limits', async (t) => {
  const server = await startServer({ requireGameData: false,
    dataDir: tmpDataDir(),
    port: 0,
    host: '127.0.0.1',
    configOverride: { limits: { msgsPerSec: 10 } },
  });
  t.after(() => server.close());

  await t.test('message flood -> RATE disconnect', async () => {
    const c = await TestClient.connect(server.port);
    await c.joinAsNew('Flooder');
    await c.waitEvent('PlayerList');
    for (let i = 0; i < 50 && !c.isClosed; i++) c.sendEvent('ChatSend', { text: `spam ${i}` });
    await c.waitDisconnect('RATE');
    await c.closed;
  });

  await t.test('4th connection from the same IP is refused', async () => {
    const conns = await Promise.all([1, 2, 3].map(() => TestClient.connect(server.port)));
    const fourth = await TestClient.connect(server.port);
    await fourth.waitDisconnect('RATE');
    const { code } = await fourth.closed;
    assert.equal(code, 1008);
    // The first three are still alive and usable.
    conns[0]!.sendJson({ t: 'SessionPing', clientTime: 1 });
    await conns[0]!.waitJson('SessionPong');
    for (const c of conns) {
      c.close();
      await c.closed;
    }
  });
});
