// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The player app served by the server itself (issue #203): what Caddy's file block used to do.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, get, type Server } from 'node:http';

import { clientRoutes } from '../src/net/client-routes';

function fixture(): string {
  const parent = mkdtempSync(join(tmpdir(), 'client-'));
  writeFileSync(join(parent, 'outside.txt'), 'secret');
  const dir = join(parent, 'play');
  mkdirSync(dir);
  writeFileSync(join(dir, 'index.html'), '<!doctype html>game');
  writeFileSync(join(dir, 'launcher.html'), '<!doctype html>launcher');
  mkdirSync(join(dir, 'e', 'abc123'), { recursive: true });
  writeFileSync(join(dir, 'e', 'abc123', 'openmw.wasm'), 'WASMBYTES0');
  writeFileSync(join(dir, 'e', 'abc123', 'openmw.wasm.br'), 'BR');
  for (const f of ['server.py', '.env', '.release-tag', 'START-HERE.txt', 'Play.bat', 'Play.command']) writeFileSync(join(dir, f), 'secret');
  mkdirSync(join(dir, 'mwdata')); writeFileSync(join(dir, 'mwdata', 'Morrowind.esm'), 'secret');
  return dir;
}

async function serve(dir: string, launcher = false): Promise<{ base: string; port: number; stop(): Promise<void> }> {
  const route = clientRoutes({ clientDir: dir, launcher: () => launcher });
  const srv: Server = createServer((req, res) => {
    void (async () => {
      if (!(await route(req, res, new URL(req.url ?? '/', 'http://x')))) { res.writeHead(404); res.end(); }
    })();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, port, stop: () => new Promise<void>((r) => srv.close(() => r())) };
}

/** A raw path, which fetch would normalise ('..', '%2e%2e') before sending. */
function rawStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port, path }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject);
  });
}

test('the game page is served cross-origin isolated, and revalidates', async () => {
  const s = await serve(fixture());
  try {
    const r = await fetch(`${s.base}/index.html`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '<!doctype html>game');
    assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(r.headers.get('cross-origin-embedder-policy'), 'require-corp');
    assert.equal(r.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    // The sign-in page's "is the player app here?" check.
    assert.equal((await fetch(`${s.base}/index.html`, { method: 'HEAD' })).status, 200);
  } finally { await s.stop(); }
});

test('/join is the launcher under its own path; /launcher.html follows the switch', async () => {
  const dir = fixture();
  const off = await serve(dir, false);
  try {
    const j = await fetch(`${off.base}/join`);
    assert.equal(j.status, 200);
    assert.equal(await j.text(), '<!doctype html>launcher');
    const l = await fetch(`${off.base}/launcher.html`, { redirect: 'manual' });
    assert.equal(l.status, 302);
    assert.equal(l.headers.get('location'), '/');
  } finally { await off.stop(); }
  const on = await serve(dir, true);
  try {
    assert.equal((await fetch(`${on.base}/launcher.html`, { redirect: 'manual' })).status, 200);
  } finally { await on.stop(); }
});

test('operator files, dotfiles, mwdata and traversal are not part of the site', async () => {
  const s = await serve(fixture());
  try {
    for (const p of ['/server.py', '/.env', '/.release-tag', '/START-HERE.txt', '/Play.bat', '/Play.command',
      '/mwdata/Morrowind.esm', '/e/', '/nope.js']) {
      assert.equal((await fetch(`${s.base}${p}`)).status, 404, p);
    }
    for (const p of ['/../outside.txt', '/%2e%2e/outside.txt', '/e/..%2f..%2fetc%2fpasswd', '/e%5c..%5cserver.py']) {
      assert.equal(await rawStatus(s.port, p), 404, p);
    }
  } finally { await s.stop(); }
});

test('the brotli sibling is used when accepted and not older than the file', async () => {
  const dir = fixture();
  const s = await serve(dir);
  try {
    const br = await fetch(`${s.base}/e/abc123/openmw.wasm`, { headers: { 'accept-encoding': 'br' } });
    assert.equal(br.headers.get('content-encoding'), 'br');
    assert.equal(br.headers.get('content-type'), 'application/wasm');
    assert.match(br.headers.get('cache-control') ?? '', /immutable/);
    await br.body?.cancel();
    const plain = await fetch(`${s.base}/e/abc123/openmw.wasm`, { headers: { 'accept-encoding': 'identity' } });
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.equal(await plain.text(), 'WASMBYTES0');
    // A stale .br is a previous engine: the plain file wins.
    const old = new Date(Date.now() - 3600_000);
    utimesSync(join(dir, 'e', 'abc123', 'openmw.wasm.br'), old, old);
    const stale = await fetch(`${s.base}/e/abc123/openmw.wasm`, { headers: { 'accept-encoding': 'br' } });
    assert.equal(stale.headers.get('content-encoding'), null);
    await stale.body?.cancel();
  } finally { await s.stop(); }
});

test('ranges and revalidation work on the plain bytes', async () => {
  const s = await serve(fixture());
  try {
    const r = await fetch(`${s.base}/e/abc123/openmw.wasm`, { headers: { range: 'bytes=0-3', 'accept-encoding': 'br' } });
    assert.equal(r.status, 206);
    assert.equal(await r.text(), 'WASM');
    assert.equal(r.headers.get('content-range'), 'bytes 0-3/10');
    const etag = (await fetch(`${s.base}/index.html`)).headers.get('etag')!;
    assert.equal((await fetch(`${s.base}/index.html`, { headers: { 'if-none-match': etag } })).status, 304);
  } finally { await s.stop(); }
});
