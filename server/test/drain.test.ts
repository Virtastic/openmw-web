// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// A RESTART IS NOT A FAILURE, and the two halves of that have to agree.
//
// The server drains gracefully — every live session is told SHUTDOWN before the socket goes —
// but the CLIENT treated that as terminal and threw the player into the fatal modal. So a
// deploy ejected everyone permanently, and rolling restart (built to avoid exactly that) would
// only have staggered the ejections. net.lua now treats SHUTDOWN as transient and falls through
// to the reconnect ladder.
//
// This pins the SERVER half: that a closing world really does announce itself, with that code,
// to a player who is in-world. The client half is asserted by scenario, not here — but if this
// ever stops being SHUTDOWN, the client's transient list silently stops matching and the fatal
// modal comes back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

test('a closing world tells its players SHUTDOWN before the socket goes', async () => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
  });
  const c = await TestClient.connect(server.port);
  await c.joinAsNew('Drainee');
  await c.waitEvent('PlayerList');

  const bye = c.waitJson('SessionDisconnect');
  await server.close();
  const msg = await bye;
  assert.equal((msg as { code?: string }).code, 'SHUTDOWN',
    'the client keys its transient-vs-terminal decision on this exact code');
  c.close();
});

// The codes that must NOT be transient. A moderator's decision, a session opened elsewhere, or
// a client dropped for flooding are all things an auto-reconnect would re-litigate — and the
// last one would hammer the very server that just shed it.
test('the terminal codes stay distinct from a restart', async () => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
  });
  try {
    const a = await TestClient.connect(server.port);
    await a.joinAsNew('Twice');
    await a.waitEvent('PlayerList');

    // Same account again: the sitting session is superseded, not restarted.
    const b = await TestClient.connect(server.port);
    b.hello();
    await b.waitJson('SessionHelloOk');
    b.login('Twice', 'hunter22');
    await b.waitJson('SessionWelcome');

    const kicked = await a.waitJson('SessionDisconnect');
    assert.equal((kicked as { code?: string }).code, 'SUPERSEDED',
      'reconnecting on this would make two sessions fight over one character');
    a.close();
    b.close();
  } finally {
    await server.close();
  }
});
