// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Savegames from the operator's side: list, export, import.
//
// Reading another account's saves is a real privilege, so the gating matters as much as the
// happy path. And an import writes into somebody's account, so what it refuses — a wrong file
// type, a name that is not a save, a scope that is not a scope — is the interesting half.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { startServer } from '../src/server';
import { tmpDataDir } from './helpers';

async function boot(t: { after(fn: () => unknown): void }) {
  const dataDir = tmpDataDir();
  mkdirSync(join(dataDir, 'gamedata'), { recursive: true });
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const owner = await fetch(`${base}/admin/api/setup/owner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'sv@example.com', password: 'a-long-enough-passphrase' }),
  });
  const token = (await owner.json() as { token: string }).token;
  return { base, auth: { authorization: `Bearer ${token}` } };
}

const jsonPost = (auth: Record<string, string>, body: unknown) => ({
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('an account with no saves reports an empty list, not an error', async (t) => {
  const { base, auth } = await boot(t);
  const r = await fetch(`${base}/admin/api/saves?account=nobody`, { headers: auth });
  assert.equal(r.status, 200);
  const body = await r.json() as { saves: unknown[]; usedBytes: number; storage: boolean };
  assert.deepEqual(body.saves, []);
  assert.equal(body.usedBytes, 0);
  assert.equal(body.storage, true, 'the filesystem backend is configured by default');
});

test('a save imported through the dashboard is listed, and comes back byte for byte', async (t) => {
  // The whole round trip, through the same two-step the game's own upload uses: presign, PUT
  // the bytes straight to storage, confirm. An imported save must be indistinguishable from one
  // the game wrote, which is why it goes through the same store and the same key layout.
  const { base, auth } = await boot(t);
  const body = Buffer.from('OMWSAVE fake payload'.repeat(64));

  const got = await (await fetch(`${base}/admin/api/saves/upload-url`, jsonPost(auth,
    { account: 'michael', scope: 'solo', name: 'Rescued.omwsave', size: body.length })))
    .json() as { url: string };
  assert.ok(got.url, 'no upload URL');

  // Relative on purpose: the browser resolves it against its own origin. See browserUrl.
  assert.ok(got.url.startsWith('/locker/blob/'), `expected a same-origin path, got ${got.url}`);
  const put = await fetch(`${base}${got.url}`, { method: 'PUT', body });
  assert.ok(put.ok, `storage refused the PUT: ${put.status}`);

  assert.equal((await fetch(`${base}/admin/api/saves/uploaded`, jsonPost(auth,
    { account: 'michael', scope: 'solo', name: 'Rescued.omwsave', size: body.length }))).status, 200);

  const list = await (await fetch(`${base}/admin/api/saves?account=michael`, { headers: auth }))
    .json() as { saves: { name: string; scope: string; size: number }[]; usedBytes: number };
  assert.deepEqual(list.saves.map((s) => [s.scope, s.name]), [['solo', 'Rescued.omwsave']]);
  assert.equal(list.usedBytes, body.length);

  const dl = await (await fetch(
    `${base}/admin/api/saves/file?account=michael&scope=solo&name=Rescued.omwsave`, { headers: auth },
  )).json() as { url: string };
  const back = Buffer.from(await (await fetch(`${base}${dl.url}`)).arrayBuffer());
  assert.deepEqual(back, body, 'what came out is not what went in');
});

test('the recorded size comes from the bucket, not from the browser', async (t) => {
  // The declared size decides the quota check. Believing it afterwards would let a client leave
  // the table describing an object that is a different size, or one that never arrived at all.
  const { base, auth } = await boot(t);
  const body = Buffer.from('x'.repeat(500));
  const { url } = await (await fetch(`${base}/admin/api/saves/upload-url`, jsonPost(auth,
    { account: 'a', scope: 'mp', name: 'A.omwsave', size: body.length }))).json() as { url: string };
  await fetch(`${base}${url}`, { method: 'PUT', body });

  await fetch(`${base}/admin/api/saves/uploaded`, jsonPost(auth,
    { account: 'a', scope: 'mp', name: 'A.omwsave', size: 999999 }));
  const list = await (await fetch(`${base}/admin/api/saves?account=a`, { headers: auth }))
    .json() as { saves: { size: number }[] };
  assert.equal(list.saves[0]!.size, body.length, 'the lie should not have been recorded');
});

test('a file that is not a savegame is refused before anything is presigned', async (t) => {
  const { base, auth } = await boot(t);
  for (const name of ['character.txt', '../../etc/passwd', 'a/b.omwsave', '', `${'x'.repeat(200)}.omwsave`]) {
    const r = await fetch(`${base}/admin/api/saves/upload-url`, jsonPost(auth,
      { account: 'a', scope: 'solo', name, size: 10 }));
    assert.equal(r.status, 400, `${JSON.stringify(name)} should be refused`);
  }
});

test('an unknown scope is refused rather than becoming a new namespace', async (t) => {
  // scope becomes part of the storage key. A free-text one would let an import write outside
  // the two namespaces the game actually uses.
  const { base, auth } = await boot(t);
  const r = await fetch(`${base}/admin/api/saves/upload-url`, jsonPost(auth,
    { account: 'a', scope: '../elsewhere', name: 'A.omwsave', size: 10 }));
  assert.equal(r.status, 400);
});

test('downloading a save that does not exist is a 404, not a probe', async (t) => {
  // The TABLE decides what exists, not storage: asking the bucket directly would let a guessed
  // name confirm whether an object is there.
  const { base, auth } = await boot(t);
  const r = await fetch(`${base}/admin/api/saves/file?account=a&scope=solo&name=Nope.omwsave`,
    { headers: auth });
  assert.equal(r.status, 404);
});

test('reading is moderator; taking a copy out or putting one in is owner', async (t) => {
  // Listing answers a support question ("how much storage is this account using"). Downloading
  // takes somebody's character off the server, and importing writes into their account.
  const { base, auth } = await boot(t);
  await fetch(`${base}/admin/api/accounts/create`, jsonPost(auth,
    { name: 'mod@example.com', password: 'another-long-passphrase', role: 'moderator' }));
  const modTok = (await (await fetch(`${base}/admin/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The login field is `name`, matching every other caller; `username` silently mismatches.
    body: JSON.stringify({ name: 'mod@example.com', password: 'another-long-passphrase' }),
  })).json() as { token?: string }).token;
  assert.ok(modTok, 'could not sign in as the moderator');
  const modAuth = { authorization: `Bearer ${modTok}` };

  assert.equal((await fetch(`${base}/admin/api/saves?account=a`, { headers: modAuth })).status, 200);
  assert.equal((await fetch(`${base}/admin/api/saves/file?account=a&scope=solo&name=A.omwsave`,
    { headers: modAuth })).status, 403);
  assert.equal((await fetch(`${base}/admin/api/saves/upload-url`, jsonPost(modAuth,
    { account: 'a', scope: 'solo', name: 'A.omwsave', size: 1 }))).status, 403);
});
