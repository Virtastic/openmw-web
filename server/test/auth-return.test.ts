// The return target is derived from the caller's origin, so the open-redirect guard is the
// only thing standing between "one build serves any hostname" and "sign-in hands a ticket to
// an attacker". These cases are the guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';

import { __testing } from '../src/auth/routes';

const { resolveReturn } = __testing;

const req = (host: string, proto?: string): IncomingMessage =>
  ({ headers: proto ? { host, 'x-forwarded-proto': proto } : { host }, socket: {} } as unknown as IncomingMessage);

// The default lands on "/", the server's own sign-in page, not on launcher.html. The
// launcher is the hosted site's chooser; a self-hosted server's front door signs the player
// in and boots the game itself.
test('derives the return origin from the request when nothing is configured', () => {
  assert.equal(resolveReturn('', req('example.test', 'https'), null),
    'https://example.test/');
});

test('the same build serves a different hostname with no config change', () => {
  assert.equal(resolveReturn('', req('other.test', 'https'), null),
    'https://other.test/');
});

test('honours a same-origin ?return=', () => {
  // An allowed URL is passed through untouched, which is the whole point of this one: it
  // must NOT be replaced by the default the refusal tests below check for.
  assert.equal(resolveReturn('', req('example.test', 'https'), 'https://example.test/launcher.html'),
    'https://example.test/launcher.html');
});

test('REFUSES a cross-origin ?return= — this is the open-redirect guard', () => {
  assert.equal(resolveReturn('', req('example.test', 'https'), 'https://evil.test/steal'),
    'https://example.test/');
});

test('refuses a same-host-different-port ?return=', () => {
  // A stale link from an older build is the likely source, and it is still not our origin.
  assert.equal(resolveReturn('', req('example.test', 'https'), 'https://example.test:8910/x'),
    'https://example.test/');
});

test('refuses a scheme-relative ?return= that resolves off-origin', () => {
  assert.equal(resolveReturn('', req('example.test', 'https'), '//evil.test/steal'),
    'https://example.test/');
});

test('refuses a javascript: ?return=', () => {
  assert.equal(resolveReturn('', req('example.test', 'https'), 'javascript:alert(1)'),
    'https://example.test/');
});

test('strips query and fragment so a ticket can never land in a query string', () => {
  assert.equal(resolveReturn('', req('example.test', 'https'), 'https://example.test/l.html?a=1#frag'),
    'https://example.test/l.html');
});

test('a configured value pins the permitted origin instead of the request origin', () => {
  const cfg = 'https://pinned.test/launcher.html';
  // Same origin as the pin: allowed, even though the request arrived on another host.
  assert.equal(resolveReturn(cfg, req('other.test', 'https'), 'https://pinned.test/launcher.html'),
    'https://pinned.test/launcher.html');
  // Matching the REQUEST but not the pin: refused, falls back to the pin.
  assert.equal(resolveReturn(cfg, req('other.test', 'https'), 'https://other.test/launcher.html'), cfg);
});

test('falls back to http when the proxy reports no TLS', () => {
  assert.equal(resolveReturn('', req('localhost:8910'), null), 'http://localhost:8910/');
});

test('no Host header yields empty, so the caller hands the ticket over as text', () => {
  assert.equal(resolveReturn('', req(''), null), '');
});
