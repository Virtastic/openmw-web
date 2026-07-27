// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// F3: the world directory. Driven over real HTTP against a fake-spawned supervisor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { WorldSupervisor } from '../src/gateway/worlds';
import { startDirectory } from '../src/gateway/directory';

class FakeChild extends EventEmitter {
  pid = 99;
  kill(sig: string): boolean { queueMicrotask(() => this.emit('exit', 0, sig)); return true; }
}

async function harness(maxWorlds = 5, maxPerOwner = 2) {
  const worlds = new WorldSupervisor({
    settings: {
      worldsDir: mkdtempSync(join(tmpdir(), 'omw-dir-')),
      serverEntry: '/fake/server.mjs', nodeBin: '/fake/node',
      basePort: 42000, maxWorlds, idleReapMs: 60_000, startTimeoutMs: 1000,
      restartBackoffMs: 1000, publicWorlds: ['vvardenfell'],
    },
    spawner: () => new FakeChild() as unknown as ChildProcess,
    fetchStatus: async (port) => ({ playerCount: 0, maxPlayers: 32, name: `w${port}` }),
  });
  worlds.startPublic();
  await worlds.poll();
  const dir = await startDirectory({
    worlds, host: '127.0.0.1', port: 0, publicHost: 'mp.example', maxPerOwner,
  });
  const base = `http://127.0.0.1:${dir.port}`;
  return { worlds, dir, base, cleanup: async () => { await dir.close(); worlds.stopAll(); } };
}

test('directory: public worlds are listed to everyone, with the dialable host', async () => {
  const h = await harness();
  try {
    const r = await (await fetch(`${h.base}/worlds`)).json() as { worlds: { id: string; host: string; port: number }[] };
    assert.equal(r.worlds.length, 1);
    assert.equal(r.worlds[0]!.id, 'vvardenfell');
    assert.equal(r.worlds[0]!.host, 'mp.example', 'the client must be told where to dial, not the internal bind host');
    assert.ok(r.worlds[0]!.port > 0);
  } finally { await h.cleanup(); }
});

test('directory: a private world is NOT listed to another account', async () => {
  const h = await harness();
  try {
    const created = await (await fetch(`${h.base}/worlds`, {
      method: 'POST', body: JSON.stringify({ id: 'alices-game', mode: 'private', account: 'alice' }),
    })).json() as { id: string };
    assert.equal(created.id, 'alices-game');

    const asBob = await (await fetch(`${h.base}/worlds?account=bob`)).json() as { worlds: { id: string }[] };
    assert.ok(!asBob.worlds.some((w) => w.id === 'alices-game'),
      "bob must not see alice's private session in the lobby");
    const anon = await (await fetch(`${h.base}/worlds`)).json() as { worlds: { id: string }[] };
    assert.ok(!anon.worlds.some((w) => w.id === 'alices-game'), 'nor may an anonymous caller');

    const asAlice = await (await fetch(`${h.base}/worlds?account=alice`)).json() as { worlds: { id: string }[] };
    assert.ok(asAlice.worlds.some((w) => w.id === 'alices-game'), 'but alice must see her own');
  } finally { await h.cleanup(); }
});

test('directory: creating the same session twice re-joins rather than forking a world', async () => {
  const h = await harness();
  try {
    const body = JSON.stringify({ id: 'party7', mode: 'party', account: 'alice' });
    const a = await (await fetch(`${h.base}/worlds`, { method: 'POST', body })).json() as { port: number };
    const b = await (await fetch(`${h.base}/worlds`, { method: 'POST', body })).json() as { port: number };
    assert.equal(a.port, b.port, 'a reconnect must land in the SAME world, not a fresh one');
    assert.equal(h.worlds.running, 2, 'public + the one party world');
  } finally { await h.cleanup(); }
});

test('directory: a client cannot conjure a public world', async () => {
  const h = await harness();
  try {
    const r = await fetch(`${h.base}/worlds`, {
      method: 'POST', body: JSON.stringify({ id: 'fake-official', mode: 'public', account: 'mallory' }),
    });
    assert.equal(r.status, 400, 'public worlds are operator config, not client-creatable');
    const list = await (await fetch(`${h.base}/worlds`)).json() as { worlds: { id: string }[] };
    assert.ok(!list.worlds.some((w) => w.id === 'fake-official'),
      'and nothing may appear in the public lobby as a result');
  } finally { await h.cleanup(); }
});

test('directory: one account cannot exhaust the platform', async () => {
  const h = await harness(10, 2); // per-owner cap 2
  try {
    for (const id of ['s1', 's2']) {
      const r = await fetch(`${h.base}/worlds`, {
        method: 'POST', body: JSON.stringify({ id, mode: 'private', account: 'greedy' }),
      });
      assert.equal(r.status, 200);
    }
    const third = await fetch(`${h.base}/worlds`, {
      method: 'POST', body: JSON.stringify({ id: 's3', mode: 'private', account: 'greedy' }),
    });
    assert.equal(third.status, 429, 'the third session for one account must be refused');
    // Another account is unaffected — the cap is per owner, not global starvation.
    const other = await fetch(`${h.base}/worlds`, {
      method: 'POST', body: JSON.stringify({ id: 's4', mode: 'private', account: 'someone-else' }),
    });
    assert.equal(other.status, 200, 'a different account must still be able to play');
  } finally { await h.cleanup(); }
});

test('directory: when the platform is full, the refusal is explicit', async () => {
  const h = await harness(2, 10); // 1 public + room for exactly 1 more
  try {
    const ok = await fetch(`${h.base}/worlds`, {
      method: 'POST', body: JSON.stringify({ id: 'first', mode: 'private', account: 'a' }),
    });
    assert.equal(ok.status, 200);
    const full = await fetch(`${h.base}/worlds`, {
      method: 'POST', body: JSON.stringify({ id: 'second', mode: 'private', account: 'b' }),
    });
    assert.equal(full.status, 503, 'a player must be told the box is full, not left hanging');
  } finally { await h.cleanup(); }
});

test('directory: malformed input is rejected, not crashed on', async () => {
  const h = await harness();
  try {
    const cases: [string, number][] = [
      [JSON.stringify({ mode: 'private', account: 'a' }), 400],           // no id
      [JSON.stringify({ id: '../../etc/passwd', mode: 'private', account: 'a' }), 400], // path traversal
      [JSON.stringify({ id: 'ok', mode: 'private' }), 400],               // no account
      ['not json at all', 400],
    ];
    for (const [body, want] of cases) {
      const r = await fetch(`${h.base}/worlds`, { method: 'POST', body });
      assert.equal(r.status, want, `body ${body.slice(0, 40)} must be rejected`);
    }
    assert.equal((await fetch(`${h.base}/healthz`)).status, 200, 'and the directory is still serving');
  } finally { await h.cleanup(); }
});
