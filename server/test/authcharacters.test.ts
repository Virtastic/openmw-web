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
import { characterRoutes, buildFrontDoor } from '../src/gateway/frontdoor';
import { tmpDataDir } from './helpers';

// The HTTP API no longer writes a slot: it hands back a provisional id and the character is
// only adopted when chargen finishes. Tests that need a REAL character therefore adopt one,
// exactly as the world does on ChargenComplete.
async function adopt(accounts: AccountStore, name: string) {
  const account = (await accounts.get('alice'))!;
  const id = accounts.provisionalCharacterId();
  const c = accounts.adoptCharacter(account, id, name);
  await accounts.flush();
  return c as Exclude<typeof c, 'full' | 'exists'>;
}

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
  return { base: `http://127.0.0.1:${port}`, auth: `Bearer ${sessions.mint('alice')}`, accounts };
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

test('list starts empty; a created character appears only once creation finishes', async (t) => {
  const { base, auth, accounts } = await boot(t);
  let r = await j(call(base, auth));
  assert.deepEqual(r.characters, []);
  assert.equal(r.max, MAX_CHARACTERS);

  const created = await j(call(base, auth, 'POST', { alias: 'Nerevarine' }));
  assert.equal(created.ok, true);
  assert.equal(created.character.name, 'Nerevarine');
  assert.equal(created.character.level, 1);
  assert.match(created.character.id, /^c[0-9a-f]{24}$/);

  // The slot is NOT written yet: a character that never finishes creation must leave no trace,
  // so nothing exists until the world reports ChargenComplete and adopts it.
  r = await j(call(base, auth));
  assert.deepEqual(r.characters, [], 'a provisional character is not a character yet');

  await adopt(accounts, 'Nerevarine');
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
  const { base, auth, accounts } = await boot(t);
  const a = { character: await adopt(accounts, 'Doomed') };
  const b = { character: await adopt(accounts, 'Keeper') };
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

// Backlog 284 / commit cfb2a83f: frontdoor.ts buildFrontDoor passes characterRoutes an
// isPlayed() derived from worldsNow (a live priv-...-<id8> world with players), and the DELETE
// refuses while it is true. Pre-fix the delete went through and stopped the world under the
// other device's feet.
test('DELETE refuses a character whose own world is up with players, through the real front door', async (t) => {
  const dir = tmpDataDir();
  let playerCount = 1;
  const worlds: { id: string; mode: string; up: boolean; playerCount: number }[] = [];
  const fd = await buildFrontDoor(dir, undefined, 8080, undefined, () => worlds);
  t.after(() => fd.close());
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    void Promise.resolve(fd.route(req, res, url)).then((claimed: boolean) => { if (!claimed) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await fd.accounts.createSso('Alice');
  const c = await adopt(fd.accounts, 'Busy');
  const auth = `Bearer ${fd.mintSession('alice')}`;
  worlds.push({ id: `priv-alice-${c.id.slice(-8)}`, mode: 'private', up: true, get playerCount() { return playerCount; } });

  const del = () => fetch(`${base}/auth/characters?id=${encodeURIComponent(c.id)}`,
    { method: 'DELETE', headers: { authorization: auth } }).then((r) => r.json() as Promise<Json>);
  const busy = await del();
  assert.equal(busy.ok, false);
  assert.match(String(busy.error), /being played/);
  assert.equal((await j(call(base, auth))).characters.length, 1, 'still there');

  playerCount = 0; // the other device signed out
  assert.equal((await del()).ok, true);
  assert.equal((await j(call(base, auth))).characters.length, 0);
});

// The world list is a poll (5 s). A player who pressed Exit and went straight to delete was
// refused against the poll from before they left (dev box, 2026-09-23). The front door now
// re-polls before refusing: a stale "in play" that a fresh poll clears lets the delete through.
test('DELETE re-reads the worlds before refusing: a stale "in play" does not block', async (t) => {
  const dir = tmpDataDir();
  let cached = 1; // what the last poll said
  let live = 0; // what the world says now: they have left
  let polls = 0;
  const worlds: { id: string; mode: string; up: boolean; playerCount: number }[] = [];
  const fd = await buildFrontDoor(dir, undefined, 8080, undefined, () => worlds,
    async () => { polls++; cached = live; });
  t.after(() => fd.close());
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    void Promise.resolve(fd.route(req, res, url)).then((claimed: boolean) => { if (!claimed) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await fd.accounts.createSso('Alice');
  const c = await adopt(fd.accounts, 'JustLeft');
  const auth = `Bearer ${fd.mintSession('alice')}`;
  worlds.push({ id: `priv-alice-${c.id.slice(-8)}`, mode: 'private', up: true, get playerCount() { return cached; } });

  const r = await fetch(`${base}/auth/characters?id=${encodeURIComponent(c.id)}`,
    { method: 'DELETE', headers: { authorization: auth } }).then((x) => x.json() as Promise<Json>);
  assert.equal(r.ok, true, `refused on a stale poll: ${String(r.error)}`);
  assert.equal(polls, 1, 'the refusal must be checked against a fresh poll');
});

test('cannot exceed MAX_CHARACTERS', async (t) => {
  const { base, auth, accounts } = await boot(t);
  // The cap counts characters that EXIST, so fill it with finished ones — a provisional id
  // reserves nothing, by design.
  for (let i = 0; i < MAX_CHARACTERS; i++) await adopt(accounts, `Hero${i}`);
  const over = await j(call(base, auth, 'POST', { alias: 'OneTooMany' }));
  assert.equal(over.ok, false);
  assert.match(String(over.error), new RegExp(String(MAX_CHARACTERS)));
});

// The point of the provisional-id design: quitting during Morrowind's opening must leave
// NOTHING. Not a tile, not a row, not a reserved slot. This is what the launcher's
// "+ New character" does when the player closes the tab mid-chargen.
test('a character abandoned during creation leaves no trace at all', async (t) => {
  const { base, auth, accounts } = await boot(t);

  // "+ New character": the launcher asks for an id and boots the game with it.
  const created = await j(call(base, auth, 'POST', { alias: 'Ghost' }));
  assert.equal(created.ok, true);
  const id = String(created.character.id);

  // ...and the player quits before finishing. Nothing adopts the id.
  const after = await j(call(base, auth));
  assert.deepEqual(after.characters, [], 'no tile on the character screen');

  const account = (await accounts.get('alice'))!;
  assert.equal((account.characters ?? []).some((c) => c.id === id), false,
    'no row in the account file either');

  // And it consumed no slot: the account is still completely empty, so the next attempt is
  // not one closer to the cap. This is why a provisional id reserves nothing.
  for (let i = 0; i < MAX_CHARACTERS; i++) await adopt(accounts, `Real${i}`);
  const full = await j(call(base, auth, 'POST', { alias: 'OneTooMany' }));
  assert.equal(full.ok, false, 'the cap counts real characters, and only real ones');
});
