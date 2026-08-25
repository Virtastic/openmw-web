// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// REVIVING A PRIVATE WORLD MUST NOT UNLOCK IT.
//
// A private world is idle-reaped after two minutes and revived when its owner dials back in,
// so "reaped, on disk, revivable" is the normal resting state of a solo world. The revive path
// called ensure(id, 'private') with no owner, which stamps OMW_WORLD_OWNER='' — and server.ts
// reads an empty owner as "admit anyone" in BOTH mayJoinWorld and wrongWorldForCharacter. Any
// signed-in account could dial /w/priv-<username>-<8hex>, both halves of which the launcher
// shows, and walk into someone else's game with any character.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { WorldSupervisor } from '../src/gateway/worlds';
import { startDirectory } from '../src/gateway/directory';

class FakeChild extends EventEmitter {
  pid = 99;
  kill(sig: string): boolean { queueMicrotask(() => this.emit('exit', 0, sig)); return true; }
}

async function harness(over: { idleReapMs?: number } = {}) {
  const wdir = mkdtempSync(join(tmpdir(), 'omw-revive-'));
  // Reported by the fake /status, so a test can put someone in a world and take them out again
  // — which is the only way to make the idle reaper engage at all.
  let players = 0;
  const worlds = new WorldSupervisor({
    settings: {
      worldsDir: wdir, gatewayPort: 8080,
      serverEntry: '/fake/server.mjs', nodeBin: '/fake/node',
      basePort: 43000, maxWorlds: 8, idleReapMs: over.idleReapMs ?? 60_000, startTimeoutMs: 1000,
      restartBackoffMs: 1000, publicWorlds: [],
      sharedDir: mkdtempSync(join(tmpdir(), 'omw-shared-')),
    },
    spawner: () => new FakeChild() as unknown as ChildProcess,
    fetchStatus: async (port) => ({ playerCount: players, connectedCount: players, maxPlayers: 32, name: `w${port}` }),
  });
  const dir = await startDirectory({
    worlds, host: '127.0.0.1', port: 0, maxPerOwner: 4, worldsDir: wdir,
    resolveAccount: (auth: string) => (auth.startsWith('Bearer ') ? auth.slice(7) : undefined),
  });
  return { worlds, dir, wdir, base: `http://127.0.0.1:${dir.port}`,
    setPlayers: (n: number) => { players = n; },
    cleanup: async () => { await dir.close(); worlds.stopAll(); } };
}

/** A raw WebSocket upgrade, which is the only way a browser reaches /w/<id>. Resolves on the
 *  first bytes back (a 502 when the world is refused, or the spliced handshake when it is not). */
function dial(port: number, path: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port }, () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let got = '';
    const done = (): void => { sock.destroy(); resolve(got); };
    sock.on('data', (b) => { got += b.toString(); done(); });
    sock.on('error', done);
    setTimeout(done, 1500).unref();
  });
}

async function createPrivate(base: string, id: string, account: string): Promise<void> {
  const r = await fetch(`${base}/worlds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${account}` },
    body: JSON.stringify({ id, mode: 'private' }),
  });
  assert.equal(r.status, 200, await r.text());
}

test('the owner survives a reap, so a revived world is still private', async () => {
  const h = await harness();
  try {
    const id = 'priv-alice-abcd1234';
    await createPrivate(h.base, id, 'alice');
    assert.equal(h.worlds.get(id)?.ownerAccount, 'alice');

    // Reap it, the way the idle poll would.
    h.worlds.stop(id);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.worlds.get(id), undefined, 'world should be stopped');
    assert.ok(existsSync(join(h.wdir, id)), 'the data dir outlives the process');

    // Dial it back. THIS IS THE ASSERTION THAT FAILED BEFORE: the world came back with
    // ownerAccount undefined, which every access check reads as "public".
    await dial(h.dir.port, `/w/${id}`);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.worlds.get(id)?.ownerAccount, 'alice',
      'a revived private world came back with no owner, which admits everyone');
  } finally {
    await h.cleanup();
  }
});

test('a world directory with no recoverable owner is not revived at all', async () => {
  const h = await harness();
  try {
    // A bare directory on disk: whatever put it there, we cannot say who owns it, so we cannot
    // authorise arrivals to it. Starting it anyway is exactly the hole.
    const id = 'priv-mallory-deadbeef';
    mkdirSync(join(h.wdir, id), { recursive: true });

    const res = await dial(h.dir.port, `/w/${id}`);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.worlds.get(id), undefined, 'an unowned private world must not be started');
    assert.match(res, /502/, 'the dial must fail so the client retry ladder can run');
  } finally {
    await h.cleanup();
  }
});

test('reviving is rate limited, so one client cannot spawn a process per directory on disk', async () => {
  const h = await harness();
  try {
    // 31 real, owned worlds, all reaped. The limiter allows 30/min from one address.
    const ids: string[] = [];
    for (let i = 0; i < 31; i++) {
      const id = `priv-owner${i}-0000000${i % 10}`;
      ids.push(id);
      await createPrivate(h.base, id, `owner${i}`);
      h.worlds.stop(id);
    }
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(h.worlds.running, 0);

    for (const id of ids) await dial(h.dir.port, `/w/${id}`);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(h.worlds.running <= 30, `revived ${h.worlds.running} worlds from one address`);
    assert.ok(h.worlds.running >= 1, 'the limit must not refuse legitimate reconnects outright');
  } finally {
    await h.cleanup();
  }
});

// THE REAL ROUND TRIP: let the REAPER do the reaping.
//
// Everything above simulates the reap with a manual stop(), which proves revival works but not
// that the thing which actually stops these worlds leaves them revivable. Those are different
// claims: the reaper could grow a "tidy up the data dir" step tomorrow and every test above
// would stay green while every solo world became unrecoverable the moment its owner stepped
// away — the exact journey that gated multiplayer off production (solo -> public -> reaped ->
// home). Drive the sweep for real, then walk back in.
test('a world the REAPER stopped is still the owner\'s when they come home', async () => {
  const h = await harness({ idleReapMs: 1 });
  try {
    const id = 'priv-alice-abcd1234';
    await createPrivate(h.base, id, 'alice');

    // Joined, then left. Idle is measured on CONNECTED clients, and a world that was never
    // reached gets a long startup grace instead — so it has to be seen occupied first, or the
    // reaper correctly leaves it alone and this measures nothing.
    h.setPlayers(1);
    await h.worlds.poll();
    h.setPlayers(0);
    await h.worlds.poll();       // starts the idle clock
    await new Promise((r) => setTimeout(r, 10));
    await h.worlds.poll();       // ...and now it is past idleReapMs
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(h.worlds.get(id), undefined, 'the reaper should have stopped it');
    assert.ok(existsSync(join(h.wdir, id)), 'the data dir must outlive the reaper');

    await dial(h.dir.port, `/w/${id}`);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.worlds.get(id)?.ownerAccount, 'alice',
      'a reaper-stopped world came back unowned, which admits everyone');
  } finally {
    await h.cleanup();
  }
});
