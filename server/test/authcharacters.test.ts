// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// /auth/characters: the pre-boot HTTP surface for the launcher's character tile screen.
// Account comes from the Bearer locker token (never the body); slots + level list, alias
// create, MAX_CHARACTERS cap, alias validation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AccountStore, MAX_CHARACTERS } from '../src/core/accounts';
import { LockerSessionStore } from '../src/auth/identities';
import { PlayerStore } from '../src/persist/playerstore';
import { characterRoutes } from '../src/gateway/frontdoor';
import { tmpDataDir } from './helpers';

async function boot(t: { after(fn: () => unknown): void }) {
  const dir = tmpDataDir();
  const accounts = new AccountStore(dir);
  await accounts.createSso('Alice'); // account key 'alice'
  const sessions = new LockerSessionStore();
  const players = new PlayerStore(dir);
  const route = characterRoutes(accounts, sessions, players);
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    void Promise.resolve(route(req, res, url)).then((claimed: boolean) => { if (!claimed) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); void accounts.close(); });
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, auth: `Bearer ${sessions.mint('alice')}` };
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = (base: string, authz: string, method = 'GET', body?: unknown) =>
  fetch(`${base}/auth/characters`, {
    method,
    headers: { ...(authz ? { authorization: authz } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const j = async (p: Promise<Response>): Promise<Json> => (await p).json() as Promise<Json>;

test('no bearer token = 401', async (t) => {
  const { base } = await boot(t);
  assert.equal((await call(base, '')).status, 401);
});

test('list starts empty; create adds a slot with level 1; list reflects it', async (t) => {
  const { base, auth } = await boot(t);
  let r = await j(call(base, auth));
  assert.deepEqual(r.characters, []);
  assert.equal(r.max, MAX_CHARACTERS);

  const created = await j(call(base, auth, 'POST', { alias: 'Nerevarine' }));
  assert.equal(created.ok, true);
  assert.equal(created.character.name, 'Nerevarine');
  assert.equal(created.character.level, 1);
  assert.match(created.character.id, /^c[0-9a-f]{24}$/);

  r = await j(call(base, auth));
  assert.equal(r.characters.length, 1);
  assert.equal(r.characters[0].name, 'Nerevarine');
  assert.equal(r.characters[0].level, 1);
});

test('a bad alias is rejected', async (t) => {
  const { base, auth } = await boot(t);
  const r = await j(call(base, auth, 'POST', { alias: 'x' })); // too short
  assert.equal(r.ok, false);
  assert.match(String(r.error), /characters/i);
});

test('delete removes the slot; an unknown id is refused', async (t) => {
  const { base, auth } = await boot(t);
  const a = await j(call(base, auth, 'POST', { alias: 'Doomed' }));
  const b = await j(call(base, auth, 'POST', { alias: 'Keeper' }));
  assert.equal((await j(call(base, auth))).characters.length, 2);

  const del = await (await fetch(`${base}/auth/characters?id=${encodeURIComponent(a.character.id)}`,
    { method: 'DELETE', headers: { authorization: auth } })).json() as Json;
  assert.equal(del.ok, true);
  const left = await j(call(base, auth));
  assert.equal(left.characters.length, 1);
  assert.equal(left.characters[0].id, b.character.id, 'the other character survives');

  // An id that is not ours (or already gone) must never delete anything.
  const bad = await (await fetch(`${base}/auth/characters?id=cdeadbeefdeadbeefdeadbeef`,
    { method: 'DELETE', headers: { authorization: auth } })).json() as Json;
  assert.equal(bad.ok, false);
  assert.equal((await j(call(base, auth))).characters.length, 1);
});

test('cannot exceed MAX_CHARACTERS', async (t) => {
  const { base, auth } = await boot(t);
  for (let i = 0; i < MAX_CHARACTERS; i++) {
    assert.equal((await j(call(base, auth, 'POST', { alias: `Hero${i}` }))).ok, true, `slot ${i}`);
  }
  const over = await j(call(base, auth, 'POST', { alias: 'OneTooMany' }));
  assert.equal(over.ok, false);
  assert.match(String(over.error), new RegExp(String(MAX_CHARACTERS)));
});
