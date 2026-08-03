// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Changing world means authenticating again: every world is its own process with its own
// in-memory resume table, and a login ticket is single-use and already spent on the first
// join. A client arriving at a second world therefore needs a FRESH credential.
//
// It gets one over HTTP from the front door (/auth/ticket, minted from the locker session),
// because a world change now reboots the page into the destination rather than redialling —
// and after a drop there is no world left to ask. The in-world RequestTravelTicket round trip
// that used to serve this is gone with the in-place switch.
//
// What must hold either way: a ticket works exactly once, and a REFUSED join does not spend
// it — the client's reconnect ladder would otherwise retry a dead credential forever, which
// is exactly how a switch came to look like it silently did nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';
import { AccountStore } from '../src/core/accounts';
import { LoginTicketStore } from '../src/auth/identities';

test('a ticket works exactly once as a credential', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const accounts = new AccountStore(dataDir);
  const acct = await accounts.register('Traveller', 'hunter22');
  assert.ok(typeof acct !== 'string');
  await accounts.flush();

  // The front door mints these from a locker session; the store is shared, so a ticket minted
  // anywhere is redeemable at any world.
  const tickets = new LoginTicketStore(15 * 60_000, dataDir);
  const ticket = tickets.mint('traveller', 'Traveller');
  assert.ok(ticket && ticket.length > 20, 'a real ticket is issued');

  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  b.hello();
  await b.waitJson('SessionHelloOk');
  b.sendJson({ t: 'SessionLoginTicket', ticket });
  await b.waitJson('SessionWelcome');

  const c = await TestClient.connect(server.port);
  t.after(() => c.close());
  c.hello();
  await c.waitJson('SessionHelloOk');
  c.sendJson({ t: 'SessionLoginTicket', ticket });
  await assert.rejects(c.waitJson('SessionWelcome'), 'single use: the second attempt fails');
});

test('a ticket refused by the destination is still usable afterwards', async (t) => {
  const dataDir = tmpDataDir();
  // A PRIVATE world owned by somebody else refuses every other account at finishAuth, which
  // is exactly the refusal that used to happen after the claim.
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    worldMode: 'private', worldOwner: 'someone-else',
    configOverride: { login: { allowHarnessAuth: true } } as never,
  });
  t.after(() => server.close());

  const accounts = new AccountStore(dataDir);
  const acct = await accounts.register('Traveller', 'hunter22');
  assert.ok(typeof acct !== 'string');
  await accounts.flush();

  const tickets = new LoginTicketStore(15 * 60_000, dataDir);
  const ticket = tickets.mint('traveller', 'Traveller');

  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  a.hello();
  await a.waitJson('SessionHelloOk');
  a.sendJson({ t: 'SessionLoginTicket', ticket });
  const refusal = await a.waitJson('SessionDisconnect');
  assert.match(String(refusal['detail'] ?? ''), /private/i, 'refused for world access, not the ticket');

  // The ticket survived the refusal: it is still claimable, so the player can go back where
  // they came from instead of being stranded with a spent credential.
  assert.ok(tickets.peek(ticket), 'the refusal spent the ticket');
  assert.ok(tickets.claim(ticket), 'the ticket must still be redeemable');
  assert.equal(tickets.claim(ticket), undefined, 'and it is single-use once actually spent');
});
