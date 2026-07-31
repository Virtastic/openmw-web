// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Changing world means authenticating again: every world is its own process with its own
// in-memory resume table, and the SSO login ticket is single-use and already spent on the
// first join. A client dialling a second world therefore had NO credential and was refused
// AUTH_FAILED every time — under SSO-only there is no fallback, so Public was unreachable.
// The world the player is already in mints the next hop's ticket into the SHARED store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

test('a joined player can mint a ticket for the world they are travelling to', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Traveller');
  await a.waitEvent('PlayerList');

  a.sendEvent('RequestTravelTicket', {});
  const evt = await a.waitEvent('TravelTicket');
  const ticket = (evt.value as { ticket: string }).ticket;
  assert.ok(ticket && ticket.length > 20, 'a real ticket is issued');

  // It must actually WORK as a credential — that is the whole point — and only once.
  const b = await TestClient.connect(server.port);
  b.hello();
  await b.waitJson('SessionHelloOk');
  b.sendJson({ t: 'SessionLoginTicket', ticket });
  await b.waitJson('SessionWelcome');

  const c = await TestClient.connect(server.port);
  c.hello();
  await c.waitJson('SessionHelloOk');
  c.sendJson({ t: 'SessionLoginTicket', ticket });
  await assert.rejects(c.waitJson('SessionWelcome'), 'single use: the second attempt fails');
});
