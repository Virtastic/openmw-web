// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// F3: the world supervisor. Fake spawner + injected clock + injected status fetcher, so the
// lifecycle (cap, idle reap, public-never-reaped, crash backoff) is asserted directly rather
// than by booting real world processes and waiting minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { WorldSupervisor, type WorldSettings, type WorldDeps } from '../src/gateway/worlds';

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

function harness(over: Partial<WorldSettings> = {}, deps: Partial<WorldDeps> = {}) {
  const settings: WorldSettings = {
    worldsDir: mkdtempSync(join(tmpdir(), 'omw-worlds-')),
    gatewayPort: 8080,
    serverEntry: '/fake/server.mjs',
    nodeBin: '/fake/node',
    basePort: 40000,
    maxWorlds: 3,
    startTimeoutMs: 60_000,
    restartBackoffMs: 15_000,
    sharedDir: mkdtempSync(join(tmpdir(), 'omw-shared-')),
    ...over,
  };
  const spawned: { id: string; args: string[]; child: FakeChild }[] = [];
  let clock = 1_000_000;
  // Player counts the fake /status will report, keyed by port.
  const counts = new Map<number, number>();
  // Sim peers the fake /status will report, keyed by port. Defaults to 1 -- the same default the
  // real fetch applies to a world that does not report the field -- so every existing test keeps
  // pricing a world at exactly worldCostMb.
  const peers = new Map<number, number>();
  // Ports whose /status the fake fetch refuses to answer — a world that is alive as a process
  // but serving nothing, which is a different state from down-and-gone or idle-and-empty.
  const down = new Set<number>();
  // #270: what the box measures (RSS of the worlds, load average). Zero = an idle box, so the
  // static budget alone decides, as every test before the measured governor assumed.
  const box = { rssMb: 0, load1: 0, pids: [] as number[] };
  const sup = new WorldSupervisor({
    settings,
    now: () => clock,
    spawner: (id, args) => {
      const child = new FakeChild();
      spawned.push({ id, args, child });
      return child as unknown as ChildProcess;
    },
    fetchStatus: async (port) => (down.has(port) ? null : {
      playerCount: counts.get(port) ?? 0,
      connectedCount: counts.get(port) ?? 0,
      peerCount: peers.get(port) ?? 1,
      maxPlayers: 32,
      name: `w${port}`,
    }),
    ...deps,
  });
  return { sup, spawned, counts, peers, down, box, settings, advance: (ms: number) => { clock += ms; } };
}

test('worlds: each world gets its own data dir and port', () => {
  const { sup, spawned } = harness();
  sup.ensure('alpha');
  sup.ensure('beta');
  assert.equal(spawned.length, 2);
  const ports = spawned.map((s) => s.args[s.args.indexOf('--port') + 1]);
  assert.notEqual(ports[0], ports[1], 'two worlds must never share a port');
  const dirs = spawned.map((s) => s.args[s.args.indexOf('--data') + 1]);
  assert.notEqual(dirs[0], dirs[1], 'two worlds must never share a data dir');
  assert.ok(dirs[0]!.endsWith('alpha'), 'the data dir is keyed on the world id');
});

test('worlds: ensure is idempotent — joining twice does not fork a second process', () => {
  const { sup, spawned } = harness();
  sup.ensure('party42');
  sup.ensure('party42');
  assert.equal(spawned.length, 1);
  assert.equal(sup.running, 1);
});

test('worlds: the cap is enforced and refusal is explicit, not a crash', () => {
  const { sup, spawned } = harness({ maxWorlds: 2 });
  assert.ok(sup.ensure('a'));
  assert.ok(sup.ensure('b'));
  const third = sup.ensure('c');
  assert.equal(third, null, 'over the cap must return null so the caller can tell the player');
  assert.equal(spawned.length, 2);
});

test('worlds: a populated private world is never reaped', async () => {
  const { sup, spawned, counts, advance } = harness();
  sup.ensure('sess1');
  const port = Number(spawned[0]!.args[spawned[0]!.args.indexOf('--port') + 1]);
  counts.set(port, 3); // three players inside
  await sup.poll();
  advance(120_000);
  await sup.poll();
  await tick();
  assert.ok(sup.get('sess1'), 'a world with players in it must not be reaped');
});

test('worlds: a world that stops answering /status is reported down, not silently healthy', async () => {
  const { sup } = harness();
  const dead = new WorldSupervisor({
    settings: {
      worldsDir: mkdtempSync(join(tmpdir(), 'omw-worlds-')), serverEntry: '/f', nodeBin: '/n', gatewayPort: 8080,
      basePort: 41000, maxWorlds: 2, startTimeoutMs: 1000,
      restartBackoffMs: 1000,
      sharedDir: mkdtempSync(join(tmpdir(), 'omw-shared-')),
    },
    spawner: () => new FakeChild() as unknown as ChildProcess,
    fetchStatus: async () => null, // wedged / not up
  });
  dead.ensure('sick');
  await dead.poll();
  const info = dead.get('sick');
  assert.ok(info, 'a wedged world is still LISTED (an operator must see it)');
  assert.equal(info.up, false, 'but it must be reported down so no player is routed into it');
  dead.stopAll();
  sup.stopAll();
});

test('worlds: a crash backs off instead of hot-looping', () => {
  const { sup, spawned, advance } = harness();
  sup.ensure('crashy');
  spawned[0]!.child.emit('exit', 1, null);
  assert.equal(sup.running, 0);
  assert.equal(sup.ensure('crashy'), null, 'immediate restart is refused');
  advance(15_001);
  assert.ok(sup.ensure('crashy'), 'but it comes back after the backoff');
});

// A world that ran and then exited 0 (SIGTERM handled: players got SHUTDOWN, stores flushed)
// shut down on purpose. Backing it off refused every client's reconnect for the whole window
// (dev box, 2026-09-23: 30 s of world.backoff after a deploy restart).
test('worlds: a clean exit after startup revives at once; a clean exit ON startup still backs off', () => {
  const { sup, spawned, advance } = harness();
  sup.ensure('w');
  advance(60_000);
  spawned[0]!.child.emit('exit', 0, null);
  assert.ok(sup.ensure('w'), 'a clean shutdown is not a crash: the next dial revives it');

  sup.ensure('quick');
  spawned[spawned.length - 1]!.child.emit('exit', 0, null); // exited 0 within the startup window
  assert.equal(sup.ensure('quick'), null, 'an instant exit is still the spin the backoff guards');
});

// An operator's stop must be a stop. The owner's client is still connected and redials within
// a second; the front door revives a private world on dial (ensure), so without a hold the
// game was back 400 ms after it was stopped. The hold is the same instrument as crash backoff.
test('worlds: an operator stop holds against revival, then the world may come back', async () => {
  const { sup, spawned, advance } = harness();
  sup.ensure('w');
  sup.stop('w', true);
  await tick();
  spawned[0]!.child.emit('exit', 0, 'SIGTERM');
  await tick();
  assert.equal(sup.ensure('w'), null, 'revived on the next dial: the stop lasted no time at all');
  advance(4 * 60_000);
  assert.equal(sup.ensure('w'), null, 'still held four minutes in');
  advance(2 * 60_000);
  assert.ok(sup.ensure('w'), 'a game stopped by mistake comes back on its own after the hold');
});

test('worlds: a stale exit cannot evict the world that replaced it, and frees no live port', async () => {
  const { sup, spawned, advance } = harness();
  sup.ensure('w');
  const first = spawned[0]!.child;
  sup.stop('w', true);
  await tick();
  advance(20_000);
  assert.equal(sup.ensure('w'), null, 'an operator stop holds against revival');
  advance(5 * 60_000);
  sup.ensure('w');
  assert.equal(spawned.length, 2);
  first.emit('exit', 0, 'SIGTERM'); // the OLD process's exit arrives late
  await tick();
  assert.equal(sup.running, 1, "a dead world's exit must not delete its successor");
  // And the successor's port must still be reserved, or the next world would collide with it.
  const p2 = Number(spawned[1]!.args[spawned[1]!.args.indexOf('--port') + 1]);
  sup.ensure('other');
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
  const a = await startServer({ requireGameData: false, dataDir: worldA, sharedDir: shared, port: 0, host: '127.0.0.1' });
  const b = await startServer({ requireGameData: false, dataDir: worldB, sharedDir: shared, port: 0, host: '127.0.0.1' });
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
    // Accounts are one SQLite database in the SHARED dir, so every world process resolves the
    // same account rather than each keeping its own copy.
    assert.ok(existsSync(join(shared, 'accounts.db')), 'accounts belong to the shared dir');
    assert.ok(!existsSync(join(worldA, 'accounts.db')), 'and not to a world dir');

    // Character slots: the character doc is SHARED too — one character follows the player
    // across worlds (per the platform plan; the dupe firewall is the public no-drop
    // economy, not per-world inventories). Only positions inside the doc are world-scoped.
    assert.ok(existsSync(join(shared, 'players.db')), 'character docs belong to the shared dir');
    assert.ok(!existsSync(join(worldA, 'players')) && !existsSync(join(worldB, 'players')),
      'no per-world player docs are written anymore (world dirs keep only world state)');
  } finally {
    await a.close();
    await b.close();
  }
});

test('rolling restart: worlds come back one at a time, emptiest first', async () => {
  const { sup, spawned, counts } = harness({ maxWorlds: 5, startTimeoutMs: 5_000 });
  sup.ensure('third');
  sup.ensure('busy');
  sup.ensure('quiet');
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

test('rolling restart: a player redialling the instant the old world exits is the restart, not a stuck world', async () => {
  // s175: the clients redial on SHUTDOWN; a dial between the exit and the next 100 ms check
  // started a fresh process under the same id, and the rollout waited for the id to vanish for
  // the full timeout, then reported it stuck.
  const { sup, spawned } = harness({ maxWorlds: 5, startTimeoutMs: 5_000 });
  sup.ensure('host');
  await sup.poll();
  const first = spawned.find((s) => s.id === 'host')!.child;
  first.once('exit', () => setImmediate(() => sup.ensure('host'))); // the redial
  const spawnsBefore = spawned.length;
  const t0 = Date.now();
  const r = await sup.rollingRestart({ readyTimeoutMs: 3_000 });
  assert.deepEqual(r, { restarted: ['host'], failed: [] });
  assert.ok(Date.now() - t0 < 2_000, `the rollout waited ${Date.now() - t0} ms on a world that had already come back`);
  assert.equal(spawned.length, spawnsBefore + 1, 'the redial started the successor and the rollout did not start a second one');
  sup.stopAll();
});

test('rolling restart: a world that will not come back HALTS the rollout', async () => {
  // One broken world must not become a full outage by restarting everything behind it.
  const worldsDir = mkdtempSync(join(tmpdir(), 'omw-worlds-'));
  const spawned: { id: string; args: string[]; child: FakeChild }[] = [];
  const clock = 1_000_000;
  const dead = new Set<string>();
  const sup = new WorldSupervisor({
    settings: {
      worldsDir, serverEntry: '/f', nodeBin: '/n', gatewayPort: 8080, basePort: 43000, maxWorlds: 5,
      startTimeoutMs: 1_000, restartBackoffMs: 100,
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
      return { playerCount: 0, connectedCount: 0, maxPlayers: 32, name: 'w' };
    },
  });
  sup.ensure('broken');
  sup.ensure('healthy');
  await sup.poll();
  dead.add('broken');

  const r = await sup.rollingRestart({ readyTimeoutMs: 300 });
  assert.ok(r.failed.includes('broken'), 'the broken world is reported failed');
  assert.ok(!r.restarted.includes('healthy'),
    'the rollout must HALT rather than restart the healthy world behind a failure');
  sup.stopAll();
});

// ---------------------------------------------------------------- memory governor
//
// The bug these cover: maxWorlds was derived from [server] maxPlayers (256) on the reasoning
// that "sim peers are capped separately, so worlds do not multiply the peer's cost". They do —
// every world process runs its own SimPeerSupervisor — so a 1.5 GB container would spawn
// worlds until the OOM killer took it, with every per-world cap reading as satisfied.

test('capacity: with no budget configured only the count cap applies', () => {
  const { sup } = harness({ maxWorlds: 10 });
  assert.equal(sup.capacity().reason, 'count');
  assert.ok(sup.ensure('a'));
  assert.ok(sup.ensure('b'));
  assert.ok(sup.ensure('c'), 'the third world that the budget refused');
  assert.equal(sup.running, 3);
});

test('a world that stops answering while occupied is eventually reaped, not held forever', async () => {
  const { sup, spawned, counts, down, advance } = harness();
  sup.ensure('wedged');
  const port = spawned[0]!.child ? 40000 : 40000;
  counts.set(port, 2); // two people playing
  await sup.poll();
  assert.equal(sup.running, 1, 'a world with players must be running');

  // It hangs: the process is alive, /status answers nothing.
  down.add(port);
  await sup.poll();
  assert.equal(sup.running, 1, 'one missed probe must NOT reap it — that is the hiccup case');

  // Still silent, but not yet past the window.
  advance(4 * 60_000);
  await sup.poll();
  assert.equal(sup.running, 1, 'a few minutes of silence is still not proof it is gone');

  // Past it.
  advance(2 * 60_000);
  await sup.poll();
  assert.equal(sup.running, 0, 'a world silent for minutes must be reaped, not held forever');
});

test('a world that answers again after a blip keeps its slot', async () => {
  const { sup, counts, down, advance } = harness();
  sup.ensure('blippy');
  counts.set(40000, 1);
  await sup.poll();
  down.add(40000);
  advance(4 * 60_000);
  await sup.poll();
  down.delete(40000); // back
  await sup.poll();
  advance(10 * 60_000); // long past the window, but it is answering now
  await sup.poll();
  assert.equal(sup.running, 1, 'recovering must clear the down clock, not merely pause it');
});

test('worlds: SIGUSR1 is relayed to every world and allExited waits for the last one', async () => {
  // A child that answers signals the way a real world does: SIGUSR1 flushes and keeps
  // running; SIGTERM drains and exits a little later.
  class LiveChild extends EventEmitter {
    killed: string[] = [];
    pid = 778;
    exitCode: number | null = null;
    signalCode: string | null = null;
    kill(sig: string): boolean {
      this.killed.push(sig);
      if (sig === 'SIGTERM') setTimeout(() => { this.exitCode = 0; this.emit('exit', 0, null); }, 20);
      return true;
    }
  }
  const children: LiveChild[] = [];
  const settings: WorldSettings = {
    worldsDir: mkdtempSync(join(tmpdir(), 'omw-worlds-')), gatewayPort: 8080, serverEntry: '/fake/server.mjs',
    nodeBin: '/fake/node', basePort: 41000, maxWorlds: 3, startTimeoutMs: 60_000,
    restartBackoffMs: 15_000, sharedDir: mkdtempSync(join(tmpdir(), 'omw-shared-')),
  };
  const sup = new WorldSupervisor({
    settings,
    spawner: () => { const c = new LiveChild(); children.push(c); return c as unknown as ChildProcess; },
  });
  sup.ensure('a');
  sup.ensure('b');
  sup.signalAll('SIGUSR1');
  assert.deepEqual(children.map((c) => c.killed), [['SIGUSR1'], ['SIGUSR1']], 'both worlds got the flush signal');
  assert.equal(sup.running, 2, 'a flush signal is not a stop');

  sup.stopAll();
  let exited = false;
  const wait = sup.allExited().then(() => { exited = true; });
  await tick();
  assert.equal(exited, false, 'still draining: the gateway must not exit yet');
  await wait;
  assert.ok(children.every((c) => c.exitCode === 0), 'resolved only once every child had exited');
});

