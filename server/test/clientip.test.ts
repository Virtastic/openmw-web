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

test('cf-connecting-ip is trusted from the proxy, and the socket address is the floor', () => {
  assert.equal(clientIp(req('172.18.0.2', { 'cf-connecting-ip': '203.0.113.7' })), '203.0.113.7');
  assert.equal(clientIp(req('198.51.100.4')), '198.51.100.4');
});

// THIS USED TO PASS THE FORGERY THROUGH. cf-connecting-ip was read from any peer whatsoever, so
// a client reaching the origin directly picked its own address: past maxConnsPerIp, past an IP
// ban, and able to spend a victim's login budget for them.
test('a REMOTE client cannot forge cf-connecting-ip or x-forwarded-for', () => {
  assert.equal(clientIp(req('198.51.100.4', { 'cf-connecting-ip': '203.0.113.7' })), '198.51.100.4');
  assert.equal(clientIp(req('198.51.100.4', { 'x-forwarded-for': '203.0.113.7' })), '198.51.100.4');
});

// THE LAUNCH-DAY BUG. Production is Caddy in a docker network with no published host ports, so
// the peer is the proxy for EVERY request. Reading it bare made loginPerMinPerIp (5) a single
// bucket for the whole server: the sixth person to click "sign in" in a minute was refused.
test('two players behind one proxy are two different addresses', () => {
  const a = clientIp(req('172.18.0.2', { 'x-forwarded-for': '203.0.113.10' }));
  const b = clientIp(req('172.18.0.2', { 'x-forwarded-for': '203.0.113.11' }));
  assert.equal(a, '203.0.113.10');
  assert.equal(b, '203.0.113.11');
  assert.notEqual(a, b, 'both players would share one rate-limit bucket');
});

// A proxy APPENDS the address it saw, so a client's own entry stays to the LEFT. Taking [0] —
// which the locker's deleted copy of this function did — reads the forgery by preference.
test('x-forwarded-for is read from the right, not the left', () => {
  assert.equal(clientIp(req('10.0.0.5', { 'x-forwarded-for': '1.2.3.4, 203.0.113.20' })), '203.0.113.20');
});

// The world processes sit behind the gateway on loopback; the locker and auth routes sit behind
// Caddy on a docker bridge. One function has to be right for both.
test('every private-range proxy is trusted, and nothing else is', () => {
  for (const peer of ['127.0.0.1', '::1', '10.1.2.3', '192.168.1.9', '172.18.0.2', '::ffff:10.0.0.1']) {
    assert.equal(clientIp(req(peer, { 'x-forwarded-for': '203.0.113.9' })), '203.0.113.9', peer);
  }
  for (const peer of ['198.51.100.4', '8.8.8.8', '172.15.0.1', '172.32.0.1', '2001:db8::1']) {
    assert.equal(clientIp(req(peer, { 'x-forwarded-for': '203.0.113.9' })), peer, peer);
  }
});
