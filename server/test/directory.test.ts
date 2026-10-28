// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// F3: the world directory. Driven over real HTTP against a fake-spawned supervisor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { WORLD_ID, WorldSupervisor } from '../src/gateway/worlds';
import { startDirectory } from '../src/gateway/directory';
import { mwDataRoutes } from '../src/net/mwdata-routes';

class FakeChild extends EventEmitter {
  pid = 99;
  kill(sig: string): boolean { queueMicrotask(() => this.emit('exit', 0, sig)); return true; }
}

async function harness(maxWorlds = 5) {
  const wdir = mkdtempSync(join(tmpdir(), 'omw-dir-'));
  const worlds = new WorldSupervisor({
    settings: {
      worldsDir: wdir, gatewayPort: 8080,
      serverEntry: '/fake/server.mjs', nodeBin: '/fake/node',
      basePort: 42000, maxWorlds, startTimeoutMs: 1000,
      restartBackoffMs: 1000,
      sharedDir: mkdtempSync(join(tmpdir(), 'omw-shared-')),
    },
    spawner: () => new FakeChild() as unknown as ChildProcess,
    fetchStatus: async (port) => ({ playerCount: 0, connectedCount: 0, maxPlayers: 32, name: `w${port}` }),
  });
  await worlds.poll();
  const dir = await startDirectory({
    worlds, host: '127.0.0.1', port: 0, 
    // Production resolves this from the locker session. Here the Bearer token IS the account,
    // so the tests exercise the same rule: who is asking comes from the verified session,
    // never from the request body (which anyone could fabricate to exhaust the world cap).
    resolveAccount: (auth: string) => (auth.startsWith('Bearer ') ? auth.slice(7) : undefined),
    // A WORLD PROCESS has no locker session to present, so this is how it proves it is part
    // of the platform and may act for a player. Without it every in-game create was 401.
    isTrustedServer: (auth: string) => auth === 'Bearer platform-secret',
  });
  const base = `http://127.0.0.1:${dir.port}`;
  return { worlds, dir, base, cleanup: async () => { await dir.close(); worlds.stopAll(); } };
}

test('directory: every create lands in the one world, whatever id the client sends', async () => {
  const h = await harness();
  try {
    const body = JSON.stringify({ id: 'party7', mode: 'party', account: 'alice' });
    const as_alice = { method: 'POST', headers: { authorization: 'Bearer alice' }, body };
    const a = await (await fetch(`${h.base}/worlds`, as_alice)).json() as { wsPath: string };
    const b = await (await fetch(`${h.base}/worlds`, as_alice)).json() as { wsPath: string };
    assert.equal(a.wsPath, b.wsPath, 'a reconnect must land in the SAME world, not a fresh one');
    assert.equal(a.wsPath, `/w/${WORLD_ID}`);
    assert.equal(h.worlds.running, 1, 'exactly the one world');
  } finally { await h.cleanup(); }
});

test('directory: malformed input is rejected, not crashed on', async () => {
  const h = await harness();
  try {
    const auth = { authorization: 'Bearer a' };
    const r = await fetch(`${h.base}/worlds`, { method: 'POST', headers: auth, body: 'not json at all' });
    assert.equal(r.status, 400, 'bad json must be rejected');

    // Spawning a world starts an OS process, so it takes a verified session. An account named
    // in the BODY is ignored entirely — that is what let one caller fabricate a new owner per
    // request and exhaust every world slot while the per-owner cap read as satisfied.
    const unauth = await fetch(`${h.base}/worlds`, {
      method: 'POST', body: JSON.stringify({ id: 'ok', mode: 'private', account: 'someone-else' }),
    });
    assert.equal(unauth.status, 401, 'world creation without a session must be refused');
    assert.equal((await fetch(`${h.base}/healthz`)).status, 200, 'and the directory is still serving');
  } finally { await h.cleanup(); }
});

test('every front-door path reaches the front door, not the directory 404', async () => {
  const h = await harness();
  const seen: string[] = [];
  const dir2 = await startDirectory({
    worlds: h.worlds, host: '127.0.0.1', port: 0, 
    resolveAccount: () => undefined,
    frontDoor: (_req, res, url) => {
      seen.push(url.pathname);
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{}');
      return true;
    },
  });
  try {
    for (const p of ['/auth/providers', '/locker/files', '/locker/blob/t/k']) {
      const r = await fetch(`http://127.0.0.1:${dir2.port}${p}`);
      assert.equal(r.status, 401, `${p} never reached the front door`);
    }
    assert.equal(seen.length, 3);
    // CL6: no route answers /saves any more, so the directory does not hand it to the front door.
    assert.equal((await fetch(`http://127.0.0.1:${dir2.port}/saves`)).status, 404);
    assert.equal(seen.length, 3);
  } finally {
    await dir2.close();
    await h.cleanup();
  }
});

test('directory: a trusted world server may create a world for a player it names', async () => {
  const h = await harness();
  try {
    const r = await fetch(`${h.base}/worlds`, {
      method: 'POST',
      headers: { authorization: 'Bearer platform-secret' },
      body: JSON.stringify({ id: 'in-game-session', mode: 'private', account: 'alice' }),
    });
    assert.equal(r.status, 200, 'the platform credential is accepted');
    const w = await r.json() as { id: string };
    assert.equal(w.id, WORLD_ID);
  } finally { await h.cleanup(); }
});

test('directory: naming an account is refused without the platform credential', async () => {
  const h = await harness();
  try {
    // THE NEGATIVE CONTROL FOR THE WHOLE MECHANISM. If a body-supplied account were honoured
    // for an anonymous caller, the per-owner cap would be decorative: fabricate a name per
    // request and one caller exhausts every world slot on the host. Mallory presents no
    // credential and no session, and claims to be alice.
    const r = await fetch(`${h.base}/worlds`, {
      method: 'POST',
      body: JSON.stringify({ id: 'stolen', mode: 'private', account: 'alice' }),
    });
    assert.equal(r.status, 401, 'no credential and no session means no world');

    // A WRONG credential is no better than none -- it must not fall through to trusting the
    // body just because an Authorization header was present.
    const r2 = await fetch(`${h.base}/worlds`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-the-secret' },
      body: JSON.stringify({ id: 'stolen2', mode: 'private', account: 'alice' }),
    });
    const owner2 = r2.status === 200
      ? (await r2.json() as { ownerAccount: string }).ownerAccount : undefined;
    assert.notEqual(owner2, 'alice',
      'a bad credential must never mint a world owned by someone else');
  } finally { await h.cleanup(); }
});

test('directory: the harness session route does not exist unless it was wired', async () => {
  // THE POINT OF THE DESIGN. mintHarnessSession is supplied by main.ts ONLY when the operator
  // has already opted into harness auth, so in production the route is ABSENT rather than
  // present-and-checking-a-flag. A locker session is a full sign-in; a route that mints one on
  // request is an account-takeover path if it ever ships enabled, which is exactly the trap
  // the fixed harness password already documents.
  const h = await harness(); // the default fixture wires no mintHarnessSession
  try {
    const r = await fetch(`${h.base}/harness/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'alice', password: 'harness-pass-1' }),
    });
    assert.notEqual(r.status, 200, 'no token may be minted when the affordance was not wired');
    const body = await r.json().catch(() => ({}));
    assert.equal((body as { token?: string }).token, undefined, 'and certainly no token in the body');
  } finally { await h.cleanup(); }
});

test('the multiplayer server hands out the game files the operator uploaded', async () => {
  const shared = mkdtempSync(join(tmpdir(), 'omw-mwdata-'));
  mkdirSync(join(shared, 'gamedata'), { recursive: true });
  writeFileSync(join(shared, 'gamedata', 'Morrowind.esm'), 'x'.repeat(64));
  let delivery = 'serve';
  const h = await harness();
  const dir2 = await startDirectory({
    worlds: h.worlds, host: '127.0.0.1', port: 0, 
    mwdata: mwDataRoutes({ gameDataDir: join(shared, 'gamedata'), mayServe: () => delivery === 'serve' }),
  });
  try {
    const base = `http://127.0.0.1:${dir2.port}`;
    const r = await fetch(`${base}/mwdata-manifest.json`);
    assert.equal(r.status, 200, 'the manifest must be served, not 404 — this is the bug');
    const files = await r.json() as { p: string; s: number }[];
    assert.deepEqual(files.map((f) => f.p), ['Morrowind.esm'], `got: ${JSON.stringify(files)}`);
    const f = await fetch(`${base}/mwdata/Morrowind.esm`);
    assert.equal(f.status, 200, 'and the files themselves');
    assert.equal((await f.text()).length, 64);

    // The stored answer still governs: turn serving off and the path stops existing, rather
    // than 403ing and confirming there is a library here to be had.
    delivery = 'byo';
    assert.equal((await fetch(`${base}/mwdata-manifest.json`)).status, 404,
      'a server that does not serve files must not advertise them');
  } finally { await dir2.close(); await h.cleanup(); }
});

test('H1: POST /worlds is rate limited per account', async () => {
  const h = await harness(10);
  try {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`${h.base}/worlds`, {
        method: 'POST', headers: { authorization: 'Bearer spammer' }, body: JSON.stringify({ id: 'sp', mode: 'private' }),
      });
      codes.push(r.status);
    }
    assert.equal(codes.filter((c) => c === 200).length, 10);
    assert.deepEqual(codes.slice(10), [429, 429]);
    const other = await fetch(`${h.base}/worlds`, {
      method: 'POST', headers: { authorization: 'Bearer bystander' }, body: JSON.stringify({ id: 'by', mode: 'private' }),
    });
    assert.equal(other.status, 200, 'another account keeps its own budget');
  } finally { await h.cleanup(); }
});
