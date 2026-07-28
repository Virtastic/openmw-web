// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 3.5: the locker HTTP surface. The auth boundary is the point — a request's account
// comes from the SSO-minted cookie, never the body, so nobody can name their way into
// another account's library.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Locker } from '../src/data/locker';
import { LockerSessionStore } from '../src/auth/identities';
import { lockerRoutes } from '../src/data/locker-routes';
import { tmpDataDir } from './helpers';

function fakeStorage() {
  return {
    async presignPut(key: string) { return `https://s.invalid/${key}?put`; },
    async presignGet(key: string) { return `https://s.invalid/${key}?get`; },
    async delete() {},
    // A valid TES3 header so the routed confirm-upload passes content sniffing.
    async getHead() {
      const b = Buffer.alloc(32);
      b.write('TES3', 0, 'latin1'); b.write('HEDR', 16, 'latin1'); b.writeFloatLE(1.2, 24);
      return b;
    },
  };
}

async function boot(t: { after(fn: () => unknown): void }) {
  const locker = new Locker({ dataDir: tmpDataDir(), maxBytesPerAccount: 1000, storage: fakeStorage() });
  locker.configureAccepted({ files: [{ name: 'Morrowind.esm', size: 100, sha256: 'a'.repeat(64) }] });
  const sessions = new LockerSessionStore();
  const route = lockerRoutes({ locker, sessions });
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    void route(req, res, url).then((claimed) => { if (!claimed) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const aliceAuth = `Bearer ${sessions.mint('alice')}`;
  return { base: `http://127.0.0.1:${port}`, aliceAuth, sessions };
}

const FILE = { name: 'Morrowind.esm', size: 100, sha256: 'a'.repeat(64) };
const call = (base: string, path: string, authz: string, method = 'GET', body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { ...(authz ? { authorization: authz } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

test('no bearer token = 401; the account is never taken from the body', async (t) => {
  const { base } = await boot(t);
  assert.equal((await call(base, '/locker/files', '')).status, 401);
  // Even a body naming "alice" gets nowhere without the token.
  const r = await fetch(`${base}/locker/authorize-upload`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...FILE, account: 'alice' }),
  });
  assert.equal(r.status, 401);
});

test('the full authorized flow: attest -> authorize -> confirm -> list -> download', async (t) => {
  const { base, aliceAuth } = await boot(t);

  // Upload is refused before an attestation exists.
  let r = await call(base, '/locker/authorize-upload', aliceAuth, 'POST', FILE);
  assert.deepEqual(await r.json(), { ok: false, reason: 'no-attestation' });

  r = await call(base, '/locker/attest', aliceAuth, 'POST', { files: [FILE] });
  const att = await r.json() as { ok: boolean; statement: string };
  assert.equal(att.ok, true);
  assert.match(att.statement, /legally purchased/);

  r = await call(base, '/locker/authorize-upload', aliceAuth, 'POST', FILE);
  const auth = await r.json() as { ok: boolean; url: string; key: string };
  assert.equal(auth.ok, true);
  assert.equal(auth.key, 'gamedata/alice/Morrowind.esm', 'per-account prefix');
  assert.match(auth.url, /\?put$/);

  await call(base, '/locker/uploaded', aliceAuth, 'POST', FILE);
  const files = await (await call(base, '/locker/files', aliceAuth)).json() as { files: unknown[] };
  assert.equal(files.files.length, 1);

  const dl = await (await call(base, '/locker/download?name=Morrowind.esm', aliceAuth)).json() as { url: string };
  assert.match(dl.url, /gamedata\/alice\/Morrowind\.esm\?get$/);
});

test('a file we do not recognize is refused — not general file hosting', async (t) => {
  const { base, aliceAuth } = await boot(t);
  await call(base, '/locker/attest', aliceAuth, 'POST', { files: [FILE] });
  const junk = { name: 'movie.mkv', size: 10, sha256: 'f'.repeat(64) };
  const r = await call(base, '/locker/authorize-upload', aliceAuth, 'POST', junk);
  assert.deepEqual(await r.json(), { ok: false, reason: 'not-recognized' });
});

test('one account cannot reach another account library', async (t) => {
  const { base, aliceAuth, sessions } = await boot(t);
  await call(base, '/locker/attest', aliceAuth, 'POST', { files: [FILE] });
  await call(base, '/locker/authorize-upload', aliceAuth, 'POST', FILE);
  await call(base, '/locker/uploaded', aliceAuth, 'POST', FILE);

  const bobAuth = `Bearer ${sessions.mint('bob')}`;
  const bobList = await (await call(base, '/locker/files', bobAuth)).json() as { files: unknown[] };
  assert.deepEqual(bobList.files, [], "bob sees his own empty library, not alice's");
  const bobDl = await call(base, '/locker/download?name=Morrowind.esm', bobAuth);
  assert.equal(bobDl.status, 404, "bob cannot name his way into alice's file");
});

test('path traversal in a filename is rejected', async (t) => {
  const { base, aliceAuth } = await boot(t);
  await call(base, '/locker/attest', aliceAuth, 'POST', { files: [FILE] });
  const evil = { name: '../bob/Morrowind.esm', size: 100, sha256: 'a'.repeat(64) };
  const r = await call(base, '/locker/authorize-upload', aliceAuth, 'POST', evil);
  assert.equal(r.status, 400);
});
