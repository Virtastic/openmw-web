// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// "This server hands out the files" — the half of the wizard's delivery step that was never
// wired. These cover the two things that make it work (a manifest, and ranged reads) and the
// two that keep it safe (the operator's answer gates it, and the path cannot escape).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';

import { mwDataRoutes } from '../src/net/mwdata-routes';

/** A game-data folder with a top-level archive and one nested media file. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mwdata-'));
  writeFileSync(join(dir, 'Morrowind.esm'), 'ABCDEFGHIJ');
  mkdirSync(join(dir, 'Music', 'Explore'), { recursive: true });
  writeFileSync(join(dir, 'Music', 'Explore', 'track.mp3'), 'xyz');
  return dir;
}

/** Boot the route on a real server, the way the rest of the suite does. */
async function serve(
  dir: string, model: string, modDoc?: () => import('../src/core/mods').ModDoc,
): Promise<{ base: string; stop(): Promise<void> }> {
  const route = mwDataRoutes({ gameDataDir: dir, deliveryModel: () => model, ...(modDoc ? { modDoc } : {}) });
  const srv: Server = createServer((req, res) => {
    void (async () => {
      if (!(await route(req, res, new URL(req.url ?? '/', 'http://x')))) { res.writeHead(404); res.end(); }
    })();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

test('serve mode publishes a manifest of every file, nested paths included', async () => {
  const s = await serve(fixture(), 'serve');
  try {
    const files = await (await fetch(`${s.base}/mwdata-manifest.json`)).json() as { p: string; s: number }[];
    const byPath = new Map(files.map((f) => [f.p, f.s]));
    assert.equal(byPath.get('Morrowind.esm'), 10);
    // Forward slashes even on Windows: the client concatenates these onto a URL.
    assert.equal(byPath.get('Music/Explore/track.mp3'), 3);
  } finally { await s.stop(); }
});

test('files are served, and RANGED — the engine reads slices, never whole archives', async () => {
  const s = await serve(fixture(), 'serve');
  try {
    const whole = await fetch(`${s.base}/mwdata/Morrowind.esm`);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    assert.equal(await whole.text(), 'ABCDEFGHIJ');

    const part = await fetch(`${s.base}/mwdata/Morrowind.esm`, { headers: { range: 'bytes=2-4' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 2-4/10');
    assert.equal(await part.text(), 'CDE');

    // A suffix range is the LAST n bytes, not an offset. Getting this backwards would corrupt
    // every read the engine makes near the end of a file.
    const tail = await fetch(`${s.base}/mwdata/Morrowind.esm`, { headers: { range: 'bytes=-3' } });
    assert.equal(tail.status, 206);
    assert.equal(await tail.text(), 'HIJ');
  } finally { await s.stop(); }
});

test('an unsatisfiable range is refused, not silently clamped', async () => {
  const s = await serve(fixture(), 'serve');
  try {
    const r = await fetch(`${s.base}/mwdata/Morrowind.esm`, { headers: { range: 'bytes=99-' } });
    assert.equal(r.status, 416);
  } finally { await s.stop(); }
});

test('WITHOUT the serve answer nothing is published at all', async () => {
  // The operator who said "everyone brings their own copy" is not distributing anything, and
  // this is the check that keeps that true. 404 rather than 403: a refusal that confirms
  // there is a library here would be its own small leak.
  const s = await serve(fixture(), 'verify');
  try {
    assert.equal((await fetch(`${s.base}/mwdata-manifest.json`)).status, 404);
    assert.equal((await fetch(`${s.base}/mwdata/Morrowind.esm`)).status, 404);
  } finally { await s.stop(); }
});

test('the path cannot escape the game-data folder', async () => {
  const dir = fixture();
  writeFileSync(join(dir, '..', 'mwdata-secret.txt'), 'not yours');
  const s = await serve(dir, 'serve');
  try {
    for (const attempt of [
      '/mwdata/../mwdata-secret.txt',
      '/mwdata/%2e%2e/mwdata-secret.txt',
      '/mwdata/Music/../../mwdata-secret.txt',
    ]) {
      const r = await fetch(`${s.base}${attempt}`, { redirect: 'manual' });
      assert.notEqual(await r.text(), 'not yours', `escaped via ${attempt}`);
    }
  } finally { await s.stop(); }
});

// --- delivery does not depend on the locker's storage backend ---------------------------------
//
// The wizard's storage question asks where UPLOADED FILES are kept, and it used to say that
// covered "any game data uploaded here". It does not, and it must not: the sim peer is a native
// OpenMW process handed `data=<a filesystem path>`, so the shared game library has to be real
// files on this machine or multiplayer cannot run at all. S3 is for the per-account locker and
// savegames. These pin that the two are independent rather than merely untested together.

test('game data and mods serve identically with S3 configured', async () => {
  const dir = fixture();
  mkdirSync(join(dir, 'mods', 'a-mod'), { recursive: true });
  writeFileSync(join(dir, 'mods', 'a-mod', 'A.esp'), 'plugin');

  const doc = {
    version: 2 as const,
    entries: [],
    mods: [{
      slug: 'a-mod', name: 'A', archive: '', source: '', installedAt: '', enabled: true,
      plugins: [{ file: 'A.esp', enabled: true }], archives: [], files: 1, bytes: 6,
    }],
  };
  // The route takes no storage at all -- which IS the assertion. If serving ever grew a
  // dependency on the locker backend, this signature would have to change and this test would
  // stop compiling, which is the warning we want.
  const s = await serve(dir, 'serve', () => doc);
  try {
    assert.equal((await fetch(`${s.base}/mwdata/mods/a-mod/A.esp`)).status, 200);
    const stack = await (await fetch(`${s.base}/mwdata-mods.json`)).json() as { content: string[] };
    assert.deepEqual(stack.content, ['A.esp']);
  } finally { await s.stop(); }
});
