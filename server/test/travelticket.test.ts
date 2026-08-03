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
import { AccountStore } from '../src/core/accounts';
import { LoginTicketStore } from '../src/auth/identities';

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

// A REFUSED JOIN MUST NOT BURN THE TICKET. handleTicket used to claim before running its
// refusals — world access, the chargen gate — so a player refused by the destination lost the
// credential too. Their client then retried the dead ticket on every reconnect and the switch
// silently did nothing: one click on Public produced six identical "login ticket expired or
// already used" refusals in the server log.
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
