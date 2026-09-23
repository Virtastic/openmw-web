// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Rate limiting: per-session message flood -> RATE disconnect; per-IP connection cap.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { metrics } from '../src/metrics';
import { TestClient, tmpDataDir } from './helpers';

test('rate limits', async (t) => {
  const server = await startServer({ requireGameData: false,
    dataDir: tmpDataDir(),
    port: 0,
    host: '127.0.0.1',
    configOverride: { limits: { msgsPerSec: 10, maxConnsPerIp: 3 } },
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

  // PlayerInput frames used to draw from msgsPerSec: a >2 s stall then the catch-up burst
  // emptied the bucket and the player was kicked with terminal RATE. Input is lossy like
  // poses -- it sheds (counted), and the JSON budget above is untouched by it.
  await t.test('input burst sheds instead of disconnecting', async () => {
    const c = await TestClient.connect(server.port);
    await c.joinAsNew('Bursty');
    await c.waitEvent('PlayerList');
    const before = metrics.rateLimited.get({ budget: 'input_shed' }) ?? 0;
    for (let i = 0; i < 130; i++) c.sendInput({}); // burst allowance is 120
    c.sendJson({ t: 'SessionPing', clientTime: 1 });
    await c.waitJson('SessionPong');
    assert.ok(!c.isClosed, 'an input burst must not disconnect');
    const shed = (metrics.rateLimited.get({ budget: 'input_shed' }) ?? 0) - before;
    assert.ok(shed >= 5, `expected >= 5 input frames shed and counted, got ${shed}`);
    c.close();
    await c.closed;
  });

  await t.test('4th connection from the same IP is refused', async () => {
    const conns = await Promise.all([1, 2, 3].map(() => TestClient.connect(server.port)));
    const fourth = await TestClient.connect(server.port);
    await fourth.waitDisconnect('IP_CAP');
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

// A household or LAN party behind one address, after a server restart: every resume is refused
// and falls back to its login ticket. Tickets used to spend the per-IP PASSWORD budget (5 a
// minute), so the sixth player was cut off with a terminal RATE. They have their own budget now,
// and a password guesser from that address is still stopped at the sixth attempt.
test('ticket sign-ins from one address have their own budget; password attempts keep theirs', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { limits: { loginPerMinPerIp: 5, maxConnsPerIp: 64 } },
  });
  t.after(() => server.close());
  async function attempt(msg: Record<string, unknown>): Promise<string> {
    const c = await TestClient.connect(server.port);
    try {
      c.hello();
      await c.waitJson('SessionHelloOk');
      c.sendJson(msg);
      const d = await c.waitJson('SessionDisconnect');
      return String((d as { code?: unknown }).code);
    } finally { c.close(); }
  }
  const tickets: string[] = [];
  for (let i = 0; i < 8; i++) tickets.push(await attempt({ t: 'SessionLoginTicket', ticket: 'spent-ticket-' + i }));
  assert.deepEqual(tickets, Array(8).fill('AUTH_FAILED'),
    'eight ticket sign-ins from one address must each be judged on the ticket, never cut off as RATE');
  const guesses: string[] = [];
  for (let i = 0; i < 6; i++) guesses.push(await attempt({ t: 'SessionLoginRequest', account: 'nobody', password: 'guess-' + i }));
  assert.ok(guesses.slice(0, 5).every((code) => code !== 'RATE'), 'the first five password attempts are judged: ' + guesses.join(','));
  assert.equal(guesses[5], 'RATE', 'the sixth password attempt from one address inside a minute is still refused');
});
