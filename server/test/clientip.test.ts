// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Behind the gateway's splice a world sees every client as 127.0.0.1, so per-IP connection
// limits became a WHOLE-WORLD cap (three sockets from one attacker locking everyone out) and
// IP bans stopped matching real addresses. The gateway now stamps the real address; the world
// trusts that header only from loopback, because a client that could set it would be able to
// forge an address and walk past both the cap and a ban.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { clientIp, CLIENT_IP_HEADER } from '../src/net/ws';

const req = (remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage =>
  ({ headers, socket: { remoteAddress } } as unknown as IncomingMessage);

test('the spliced client address is trusted from loopback', () => {
  assert.equal(clientIp(req('127.0.0.1', { [CLIENT_IP_HEADER]: '203.0.113.9' })), '203.0.113.9');
  assert.equal(clientIp(req('::1', { [CLIENT_IP_HEADER]: '203.0.113.9' })), '203.0.113.9');
});

test('a REMOTE client cannot forge its own address', () => {
  // The attack: set the header yourself to dodge maxConnsPerIp or an IP ban.
  assert.equal(clientIp(req('198.51.100.4', { [CLIENT_IP_HEADER]: '203.0.113.9' })), '198.51.100.4');
});

test('cf-connecting-ip still works, and the socket address is the floor', () => {
  assert.equal(clientIp(req('198.51.100.4', { 'cf-connecting-ip': '203.0.113.7' })), '203.0.113.7');
  assert.equal(clientIp(req('198.51.100.4')), '198.51.100.4');
});
