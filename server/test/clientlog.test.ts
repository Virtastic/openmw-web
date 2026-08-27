// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// /clientlog — the client's half of the conversation, in the same stream as the server's.
//
// Every client-side fault this project has chased was invisible from the server: a Lua handler
// that threw and silently disabled a whole subsystem, a doubled loading overlay, an OpenAL enum
// error, a WebGL warning. Each was found by whoever happened to be watching their own console,
// which does not scale past one person and leaves nothing to read afterwards. Server events
// already land as structured JSON; this endpoint puts client lines beside them.
//
// It is deliberately UNAUTHENTICATED, because the most valuable report comes from a client that
// FAILED TO JOIN and therefore has no session to authenticate with. That makes it an open POST
// endpoint on the public internet, so the bounds asserted here are the feature rather than
// decoration: without them it is free storage and a flood vector.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server';

async function boot(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dataDir = mkdtempSync(join(tmpdir(), 'omw-clientlog-'));
  // A multiplayer server refuses to boot without game data; presence is all detectGameData
  // checks, and this test is about HTTP, not content.
  const gd = join(dataDir, 'gamedata');
  mkdirSync(gd, { recursive: true });
  for (const f of ['Morrowind.esm', 'Morrowind.bsa']) writeFileSync(join(gd, f), '');
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: { time: { scale: 0 } },
  });
  t.after(async () => { await server.close(); });
  return `http://127.0.0.1:${server.port}`;
}

const post = (base: string, body: string): Promise<Response> =>
  fetch(`${base}/clientlog`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });

test('clientlog: accepts a batch', async (t) => {
  const base = await boot(t);
  const r = await post(base, JSON.stringify({
    session: 'abc123', lines: ['[mp] Lua error: boom', 'an ordinary line'],
  }));
  assert.equal(r.status, 204);
});

test('clientlog: junk is refused, not thrown on', async (t) => {
  const base = await boot(t);
  assert.equal((await post(base, 'not json')).status, 400);
  assert.equal((await post(base, JSON.stringify({ lines: 'nope' }))).status, 400,
    'lines must be an array');
});

// THE BOUND THAT MATTERS on an endpoint anyone can POST to. 256 KB is generous for a burst of
// engine warnings on a bad boot and useless as a place to put anything else. Asserted as a
// REFUSAL rather than a truncation: silently accepting an oversized body would let a caller
// keep sending them.
test('clientlog: an oversized body is refused', async (t) => {
  const base = await boot(t);
  const r = await post(base, JSON.stringify({ lines: ['x'.repeat(300 * 1024)] }));
  assert.equal(r.status, 413);
});

// CORS, because the page posting these is served from a different origin than the world in
// every deployment that has a gateway in front.
test('clientlog: preflight is answered', async (t) => {
  const base = await boot(t);
  const r = await fetch(`${base}/clientlog`, { method: 'OPTIONS' });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});
