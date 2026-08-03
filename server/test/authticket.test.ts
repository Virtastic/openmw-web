// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// POST /auth/ticket: the character-select screen re-enters worlds after the original SSO
// ticket was spent. The locker Bearer token (proof of the SSO login) mints a fresh single-use
// login ticket; no token = 401, and the minted ticket claims to the right account.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AccountStore } from '../src/core/accounts';
import { LockerSessionStore, LoginTicketStore } from '../src/auth/identities';
import { ticketRoutes } from '../src/gateway/frontdoor';
import { tmpDataDir } from './helpers';

test('locker token mints a claimable single-use ticket; no token = 401', async (t) => {
  const accounts = new AccountStore(tmpDataDir());
  await accounts.createSso('Alice');
  const sessions = new LockerSessionStore();
  const tickets = new LoginTicketStore();
  const route = ticketRoutes(accounts, sessions, tickets);
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    void Promise.resolve(route(req, res, url)).then((claimed: boolean) => { if (!claimed) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); void accounts.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  assert.equal((await fetch(`${base}/auth/ticket`, { method: 'POST' })).status, 401);

  const auth = `Bearer ${sessions.mint('alice')}`;
  const r = await (await fetch(`${base}/auth/ticket`, { method: 'POST', headers: { authorization: auth } })).json() as { ticket: string };
  assert.ok(r.ticket && r.ticket.length >= 32, 'a real ticket is minted');
  const claimed = tickets.claim(r.ticket);
  assert.equal(claimed?.accountKey, 'alice', 'ticket claims to the right account');
  assert.equal(tickets.claim(r.ticket), undefined, 'single-use: a second claim fails');
});
