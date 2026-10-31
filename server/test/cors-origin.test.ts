import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { corsOrigin } from '../src/net/http';

// OT3-104: the upload/front-door CORS answer is per request origin, never a fixed old origin,
// and every answer carries Vary: Origin so a cache cannot hand one origin's headers to another.
function run(headers: Record<string, string>): Map<string, string> {
  const set = new Map<string, string>();
  const req = { headers, socket: { remoteAddress: '203.0.113.9' } } as unknown as IncomingMessage;
  const res = { setHeader: (k: string, v: string) => { set.set(k.toLowerCase(), v); } } as unknown as ServerResponse;
  corsOrigin(req, res);
  return set;
}

test('OT3-104: opentes3.com page uploading to its own host is allowed, with Vary: Origin', () => {
  const h = run({ host: 'opentes3.com', origin: 'http://opentes3.com' });
  assert.equal(h.get('vary'), 'Origin');
  assert.equal(h.get('access-control-allow-origin'), 'http://opentes3.com');
});

test('OT3-104: an unlisted origin gets no ACAO but still Vary: Origin', () => {
  const h = run({ host: 'opentes3.com', origin: 'https://evil.example' });
  assert.equal(h.get('vary'), 'Origin');
  assert.equal(h.has('access-control-allow-origin'), false);
});

test('OT3-104: no Origin header (same-site fetch, curl) still varies on Origin', () => {
  const h = run({ host: 'opentes3.com' });
  assert.equal(h.get('vary'), 'Origin');
  assert.equal(h.has('access-control-allow-origin'), false);
});
