// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// F3: the world supervisor. Fake spawner + injected clock + injected status fetcher, so the
// lifecycle (cap, idle reap, public-never-reaped, crash backoff) is asserted directly rather
// than by booting real world processes and waiting minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { WorldSupervisor, type WorldSettings } from '../src/gateway/worlds';

class FakeChild extends EventEmitter {
  killed: string[] = [];
  pid = 777;
  kill(sig: string): boolean {
    this.killed.push(sig);
    queueMicrotask(() => this.emit('exit', 0, sig));
    return true;
  }
}

const tick = () => new Promise((r) => setImmediate(r));

function harness(over: Partial<WorldSettings> = {}) {
  const settings: WorldSettings = {
    worldsDir: mkdtempSync(join(tmpdir(), 'omw-worlds-')),
    serverEntry: '/fake/server.mjs',
    nodeBin: '/fake/node',
    basePort: 40000,
    maxWorlds: 3,
    idleReapMs: 60_000,
    startTimeoutMs: 60_000,
    restartBackoffMs: 15_000,
    publicWorlds: ['vvardenfell'],
    sharedDir: mkdtempSync(join(tmpdir(), 'omw-shared-')),
    ...over,
  };
  const spawned: { id: string; args: string[]; child: FakeChild }[] = [];
  let clock = 1_000_000;
  // Player counts the fake /status will report, keyed by port.
  const counts = new Map<number, number>();
  const sup = new WorldSupervisor({
    settings,
    now: () => clock,
    spawner: (id, args) => {
      const child = new FakeChild();
      spawned.push({ id, args, child });
      return child as unknown as ChildProcess;
    },
    fetchStatus: async (port) => ({ playerCount: counts.get(port) ?? 0, maxPlayers: 32, name: `w${port}` }),
  });
  return { sup, spawned, counts, advance: (ms: number) => { clock += ms; } };
}

test('worlds: each world gets its own data dir and port', () => {
  const { sup, spawned } = harness();
  sup.ensure('alpha', 'private');
  sup.ensure('beta', 'private');
  assert.equal(spawned.length, 2);
  const ports = spawned.map((s) => s.args[s.args.indexOf('--port') + 1]);
  assert.notEqual(ports[0], ports[1], 'two worlds must never share a port');
  const dirs = spawned.map((s) => s.args[s.args.indexOf('--data') + 1]);
  assert.notEqual(dirs[0], dirs[1], 'two worlds must never share a data dir');
  assert.ok(dirs[0]!.endsWith('alpha'), 'the data dir is keyed on the world id');
});

test('worlds: ensure is idempotent — joining twice does not fork a second process', () => {
  const { sup, spawned } = harness();
  sup.ensure('party42', 'party');
  sup.ensure('party42', 'party');
  assert.equal(spawned.length, 1);
  assert.equal(sup.running, 1);
});

test('worlds: the cap is enforced and refusal is explicit, not a crash', () => {
  const { sup, spawned } = harness({ maxWorlds: 2 });
  assert.ok(sup.ensure('a', 'private'));
  assert.ok(sup.ensure('b', 'private'));
  const third = sup.ensure('c', 'private');
  assert.equal(third, null, 'over the cap must return null so the caller can tell the player');
  assert.equal(spawned.length, 2);
});

test('worlds: an empty PRIVATE world is reaped; an empty PUBLIC world is not', async () => {
  const { sup, advance } = harness();
  sup.startPublic();          // vvardenfell, public
  sup.ensure('sess1', 'private');
  await sup.poll();           // both empty
  advance(61_000);
  await sup.poll();
  await tick();
  assert.ok(sup.get('vvardenfell'), 'a public world must stay up when empty — that is the point of public');
  assert.equal(sup.get('sess1'), undefined, 'an abandoned private session must be reaped');
});

test('worlds: a populated private world is never reaped', async () => {
  const { sup, spawned, counts, advance } = harness();
  sup.ensure('sess1', 'private');
  const port = Number(spawned[0]!.args[spawned[0]!.args.indexOf('--port') + 1]);
  counts.set(port, 3); // three players inside
  await sup.poll();
  advance(120_000);
  await sup.poll();
  await tick();
  assert.ok(sup.get('sess1'), 'a world with players in it must not be reaped');
});

test('worlds: players leaving starts the idle clock, returning cancels it', async () => {
  const { sup, spawned, counts, advance } = harness();
  sup.ensure('sess1', 'private');
  const port = Number(spawned[0]!.args[spawned[0]!.args.indexOf('--port') + 1]);
  counts.set(port, 2);
  await sup.poll();
  counts.set(port, 0);       // everyone left
  await sup.poll();          // idle clock starts
  advance(50_000);
  counts.set(port, 1);       // someone came back before the deadline
  await sup.poll();
  advance(30_000);           // past the ORIGINAL deadline
  await sup.poll();
  await tick();
  assert.ok(sup.get('sess1'), 'the reap must be cancelled by the returning player, not merely delayed');
});

test('worlds: a world that stops answering /status is reported down, not silently healthy', async () => {
  const { sup } = harness();
  const dead = new WorldSupervisor({
    settings: {
      worldsDir: mkdtempSync(join(tmpdir(), 'omw-worlds-')), serverEntry: '/f', nodeBin: '/n',
      basePort: 41000, maxWorlds: 2, idleReapMs: 60_000, startTimeoutMs: 1000,
      restartBackoffMs: 1000, publicWorlds: [],
      sharedDir: mkdtempSync(join(tmpdir(), 'omw-shared-')),
    },
    spawner: () => new FakeChild() as unknown as ChildProcess,
    fetchStatus: async () => null, // wedged / not up
  });
  dead.ensure('sick', 'private');
  await dead.poll();
  const info = dead.get('sick');
  assert.ok(info, 'a wedged world is still LISTED (an operator must see it)');
  assert.equal(info.up, false, 'but it must be reported down so no player is routed into it');
  dead.stopAll();
  sup.stopAll();
});

test('worlds: a crash backs off instead of hot-looping', () => {
  const { sup, spawned, advance } = harness();
  sup.ensure('crashy', 'private');
  spawned[0]!.child.emit('exit', 1, null);
  assert.equal(sup.running, 0);
  assert.equal(sup.ensure('crashy', 'private'), null, 'immediate restart is refused');
  advance(15_001);
  assert.ok(sup.ensure('crashy', 'private'), 'but it comes back after the backoff');
});

test('worlds: a stale exit cannot evict the world that replaced it, and frees no live port', async () => {
  const { sup, spawned, advance } = harness();
  sup.ensure('w', 'private');
  const first = spawned[0]!.child;
  sup.stop('w');
  await tick();
  advance(20_000);
  sup.ensure('w', 'private');
  assert.equal(spawned.length, 2);
  first.emit('exit', 0, 'SIGTERM'); // the OLD process's exit arrives late
  await tick();
  assert.equal(sup.running, 1, "a dead world's exit must not delete its successor");
  // And the successor's port must still be reserved, or the next world would collide with it.
  const p2 = Number(spawned[1]!.args[spawned[1]!.args.indexOf('--port') + 1]);
  sup.ensure('other', 'private');
  const p3 = Number(spawned[2]!.args[spawned[2]!.args.indexOf('--port') + 1]);
  assert.notEqual(p3, p2, 'the live successor keeps its port reserved');
});

// F1: the gap F3 exposed. Every store was scoped to the per-world dataDir, which was
// harmless with one world and blocking with many: a player could not log into their own
// private session with the account they registered in the public world.
test('shared: one account works across worlds; per-world state stays separate', async () => {
  const { startServer } = await import('../src/server');
  const { TestClient, tmpDataDir } = await import('./helpers');
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');

  const shared = tmpDataDir();
  const worldA = tmpDataDir();
  const worldB = tmpDataDir();
  const a = await startServer({ dataDir: worldA, sharedDir: shared, port: 0, host: '127.0.0.1' });
  const b = await startServer({ dataDir: worldB, sharedDir: shared, port: 0, host: '127.0.0.1' });
  try {
    // Register in world A only.
    const c1 = await TestClient.connect(a.port);
    await c1.joinAsNew('traveller');
    c1.ws.close();
    await a.flush();

    // The SAME credentials must work in world B, which the player has never visited.
    const c2 = await TestClient.connect(b.port);
    const welcome = await c2.joinExisting('traveller');
    assert.ok(welcome, 'one account must work in every world — this is the whole point of sharedDir');
    c2.ws.close();
    await b.flush();

    // Accounts live in the SHARED dir, not in either world.
    assert.ok(existsSync(join(shared, 'accounts')), 'accounts belong to the shared dir');
    assert.ok(!existsSync(join(worldA, 'accounts')), 'and not to a world dir');

    // But per-world game state stays per world: a character in each, so an item cannot be
    // duplicated by carrying one inventory into a second world.
    assert.ok(existsSync(join(worldA, 'players')) || existsSync(join(worldB, 'players')),
      'player docs stay per world');
    assert.ok(!existsSync(join(shared, 'players')), 'player docs must NOT be shared');
  } finally {
    await a.close();
    await b.close();
  }
});

test('rolling restart: worlds come back one at a time, emptiest first', async () => {
  const { sup, spawned, counts } = harness({ maxWorlds: 5, startTimeoutMs: 5_000 });
  sup.startPublic();                 // vvardenfell
  sup.ensure('busy', 'private');
  sup.ensure('quiet', 'private');
  await sup.poll();
  const portOf = (id: string): number => {
    const s = spawned.find((x) => x.id === id)!;
    return Number(s.args[s.args.indexOf('--port') + 1]);
  };
  counts.set(portOf('busy'), 9);     // populated
  counts.set(portOf('quiet'), 0);
  await sup.poll();

  const spawnsBefore = spawned.length;
  const r = await sup.rollingRestart({ readyTimeoutMs: 3_000 });

  assert.equal(r.failed.length, 0, `nothing should fail: ${r.failed.join(',')}`);
  assert.equal(r.restarted.length, 3, 'every world is restarted');
  assert.equal(spawned.length, spawnsBefore + 3, 'each world is started exactly once more');
  // Emptiest first: the busy world is restarted LAST, so its players are disturbed latest
  // and an aborted rollout leaves the populated world untouched.
  assert.equal(r.restarted[r.restarted.length - 1], 'busy',
    `the busiest world must go last, order was ${r.restarted.join(' -> ')}`);
  assert.equal(sup.running, 3, 'all three are up again');
});

test('rolling restart: a world that will not come back HALTS the rollout', async () => {
  // One broken world must not become a full outage by restarting everything behind it.
  const worldsDir = mkdtempSync(join(tmpdir(), 'omw-worlds-'));
  const spawned: { id: string; args: string[]; child: FakeChild }[] = [];
  const clock = 1_000_000;
  const dead = new Set<string>();
  const sup = new WorldSupervisor({
    settings: {
      worldsDir, serverEntry: '/f', nodeBin: '/n', basePort: 43000, maxWorlds: 5,
      idleReapMs: 60_000, startTimeoutMs: 1_000, restartBackoffMs: 100, publicWorlds: [],
      sharedDir: mkdtempSync(join(tmpdir(), 'omw-shared-')),
    },
    now: () => clock,
    spawner: (id, args) => {
      const child = new FakeChild();
      spawned.push({ id, args, child });
      return child as unknown as ChildProcess;
    },
    // Once restarted, 'broken' never answers /status again.
    fetchStatus: async (port) => {
      const rec = spawned.find((s) => Number(s.args[s.args.indexOf('--port') + 1]) === port);
      if (rec && dead.has(rec.id)) return null;
      return { playerCount: 0, maxPlayers: 32, name: 'w' };
    },
  });
  sup.ensure('broken', 'private');
  sup.ensure('healthy', 'private');
  await sup.poll();
  dead.add('broken');

  const r = await sup.rollingRestart({ readyTimeoutMs: 300 });
  assert.ok(r.failed.includes('broken'), 'the broken world is reported failed');
  assert.ok(!r.restarted.includes('healthy'),
    'the rollout must HALT rather than restart the healthy world behind a failure');
  sup.stopAll();
});
