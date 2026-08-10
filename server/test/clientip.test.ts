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
import { setTrustCloudflareIp } from '../src/net/http';

const req = (remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage =>
  ({ headers, socket: { remoteAddress } } as unknown as IncomingMessage);

test('the spliced client address is trusted from loopback', () => {
  assert.equal(clientIp(req('127.0.0.1', { [CLIENT_IP_HEADER]: '203.0.113.9' })), '203.0.113.9');
  assert.equal(clientIp(req('::1', { [CLIENT_IP_HEADER]: '203.0.113.9' })), '203.0.113.9');
});

// LOOPBACK ONLY, and this is not pedantry: it was briefly widened to "any private peer" and
// that shipped a live bypass. The gateway splices to a world over 127.0.0.1 and stamps the
// header itself; a reverse proxy on a docker bridge is a private peer too, and it forwards
// whatever the client sent — so any client could name its own address, reset its login rate
// limit, walk past an IP ban and maxConnsPerIp, and pin its failures on someone else.
// Confirmed against the live dev deployment before it was narrowed back.
test('the spliced client address is NOT trusted from a private proxy', () => {
  for (const peer of ['172.18.0.2', '10.1.2.3', '192.168.1.9']) {
    assert.equal(clientIp(req(peer, { [CLIENT_IP_HEADER]: '203.0.113.9' })), peer, peer);
  }
  // ...and the proxy's own X-Forwarded-For is still honoured from those peers, so narrowing
  // this header did not take the real client address away with it.
  assert.equal(clientIp(req('172.18.0.2',
    { [CLIENT_IP_HEADER]: '203.0.113.9', 'x-forwarded-for': '198.51.100.7' })), '198.51.100.7');
});

test('a REMOTE client cannot forge its own address', () => {
  // The attack: set the header yourself to dodge maxConnsPerIp or an IP ban.
  assert.equal(clientIp(req('198.51.100.4', { [CLIENT_IP_HEADER]: '203.0.113.9' })), '198.51.100.4');
});

// OFF BY DEFAULT. Probing the gateway directly from inside the docker network — past the
// edge's header strip — showed a forged CF-Connecting-IP buying a fresh login budget while the
// control stayed refused. Where Cloudflare is not in front, nothing legitimately sets this
// header, so believing it is pure attack surface.
test('cf-connecting-ip is ignored unless the deployment opts in', () => {
  assert.equal(clientIp(req('172.18.0.2', { 'cf-connecting-ip': '203.0.113.7' })), '172.18.0.2');
  try {
    setTrustCloudflareIp(true);
    assert.equal(clientIp(req('172.18.0.2', { 'cf-connecting-ip': '203.0.113.7' })), '203.0.113.7');
    // Even opted in, it is only believed from a proxy — never from the open internet.
    assert.equal(clientIp(req('198.51.100.4', { 'cf-connecting-ip': '203.0.113.7' })), '198.51.100.4');
  } finally {
    setTrustCloudflareIp(false);
  }
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

// The misconfiguration that is silent and dangerous: off while Cloudflare IS in front. Every
// client then resolves to the edge, per-IP limits become one global bucket, and the sixth
// person to sign in within a minute is refused — the fault this whole sweep began by fixing.
// Seeing the header arrive from a trusted proxy is the tell, so it must not pass unremarked.
test('an ignored cf-connecting-ip from a trusted proxy is still resolved by other means', () => {
  // Falls through to X-Forwarded-For rather than silently keying everyone on the proxy.
  assert.equal(
    clientIp(req('172.18.0.2', { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.9' })),
    '198.51.100.9');
  // With nothing else to go on, the proxy address IS the answer — that is the collapse the
  // boot log and the runtime warning exist to make visible.
  assert.equal(clientIp(req('172.18.0.2', { 'cf-connecting-ip': '203.0.113.7' })), '172.18.0.2');
});
