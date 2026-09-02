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
    gatewayPort: 8080,
    serverEntry: '/fake/server.mjs',
    nodeBin: '/fake/node',
    basePort: 40000,
    maxWorlds: 3,
    idleReapMs: 60_000,
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
  const sup = new WorldSupervisor({
    settings,
    now: () => clock,
    spawner: (id, args) => {
      const child = new FakeChild();
      spawned.push({ id, args, child });
      return child as unknown as ChildProcess;
    },
    fetchStatus: async (port) => ({
      playerCount: counts.get(port) ?? 0,
      connectedCount: counts.get(port) ?? 0,
      peerCount: peers.get(port) ?? 1,
      maxPlayers: 32,
      name: `w${port}`,
    }),
  });
  return { sup, spawned, counts, peers, advance: (ms: number) => { clock += ms; } };
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

test('worlds: a JOINED-then-abandoned private world is reaped; a never-joined one survives the startup grace', async () => {
  const { sup, advance, counts } = harness();
  const s1 = sup.ensure('sess1', 'private')!;
  // Someone joins (connectedCount>0) then leaves — the idle reaper applies after they go.
  counts.set(s1.port, 1); await sup.poll();                 // everConnected
  counts.set(s1.port, 0); await sup.poll();                 // they left -> idle clock starts now
  advance(61_000); await sup.poll(); await tick();          // idle window elapsed -> reaped
  assert.equal(sup.get('sess1'), undefined, 'a joined-then-abandoned private session is reaped after the idle window');
  // A brand-new world nobody has REACHED yet is NOT reaped inside the idle window: a first-play
  // client may still be downloading its data (minutes) before it connects. The startup grace holds.
  sup.ensure('sess2', 'private');
  advance(61_000); await sup.poll(); await tick();
  assert.ok(sup.get('sess2'), 'a never-joined world survives the startup grace (client may still be loading toward it)');
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
      worldsDir: mkdtempSync(join(tmpdir(), 'omw-worlds-')), serverEntry: '/f', nodeBin: '/n', gatewayPort: 8080,
      basePort: 41000, maxWorlds: 2, idleReapMs: 60_000, startTimeoutMs: 1000,
      restartBackoffMs: 1000,
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
  sup.ensure('third', 'private');
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
      worldsDir, serverEntry: '/f', nodeBin: '/n', gatewayPort: 8080, basePort: 43000, maxWorlds: 5,
      idleReapMs: 60_000, startTimeoutMs: 1_000, restartBackoffMs: 100,
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

// ---------------------------------------------------------------- memory governor
//
// The bug these cover: maxWorlds was derived from [server] maxPlayers (256) on the reasoning
// that "sim peers are capped separately, so worlds do not multiply the peer's cost". They do —
// every world process runs its own SimPeerSupervisor — so a 1.5 GB container would spawn
// worlds until the OOM killer took it, with every per-world cap reading as satisfied.

test('capacity: the memory budget binds when it is tighter than the count cap', () => {
  // 2048 usable after the 256 MB reserve, at 780 MB per world -> 2 worlds, not 10.
  const { sup } = harness({
    maxWorlds: 10, memBudgetMb: 2304, worldCostMb: 780, gatewayReserveMb: 256,
  });
  const cap = sup.capacity();
  assert.equal(cap.cap, 2);
  assert.equal(cap.reason, 'memory');

  assert.ok(sup.ensure('a', 'private', 'ann'), 'first world fits');
  assert.ok(sup.ensure('b', 'private', 'bob'), 'second world fits');
  assert.equal(sup.ensure('c', 'private', 'cid'), null, 'third is refused by the memory budget');
  assert.equal(sup.running, 2);
});

test('capacity: the count cap still binds when it is the tighter of the two', () => {
  const { sup } = harness({
    maxWorlds: 1, memBudgetMb: 100_000, worldCostMb: 780, gatewayReserveMb: 256,
  });
  assert.deepEqual(
    { cap: sup.capacity().cap, reason: sup.capacity().reason },
    { cap: 1, reason: 'count' },
  );
  assert.ok(sup.ensure('a', 'private', 'ann'));
  assert.equal(sup.ensure('b', 'private', 'bob'), null);
});

// NEGATIVE CONTROL. Remove the budget and the SAME calls succeed — so the refusal above is
// the governor doing its job, not the harness running out of ports or the fake spawner
// failing. Deleting the memBudgetMb check in ensure() makes the first test fail and this one
// keep passing, which is the discrimination that matters.
test('capacity: with no budget configured only the count cap applies', () => {
  const { sup } = harness({ maxWorlds: 10 });
  assert.equal(sup.capacity().reason, 'count');
  assert.ok(sup.ensure('a', 'private', 'ann'));
  assert.ok(sup.ensure('b', 'private', 'bob'));
  assert.ok(sup.ensure('c', 'private', 'cid'), 'the third world that the budget refused');
  assert.equal(sup.running, 3);
});

// A budget too small for one world must still run one. Refusing everything would make a
// fat-fingered memBudgetMb indistinguishable from a broken gateway — the failure mode this
// whole governor exists to make legible.
test('capacity: a budget below one world still admits one, and says so', () => {
  const { sup } = harness({
    maxWorlds: 10, memBudgetMb: 300, worldCostMb: 780, gatewayReserveMb: 256,
  });
  assert.equal(sup.capacity().cap, 1);
  assert.ok(sup.ensure('a', 'private', 'ann'));
  assert.equal(sup.ensure('b', 'private', 'bob'), null);
});

// THE SECOND HALF OF THE SAME BUG, and it was introduced by the fix to the FIRST half's
// neighbour. The governor above prices a world at a constant, which was honest while a world
// ran exactly one sim peer. It no longer does: peers are one per OCCUPIED CELL, so a party
// spread over four cells is four engines in a single world -- about 2100 MB against the 640 the
// governor still charges. A budget sized on the old arithmetic then permits roughly three times
// the RAM the box has, and every per-world cap reads as satisfied right up to the OOM kill.
//
// This is the same failure the memory governor was written to prevent, reintroduced underneath
// it by a change one layer down, which is why it is worth a test rather than a comment.
test('capacity: a world running several peers is priced for all of them', async () => {
  const { sup, spawned, peers } = harness({
    maxWorlds: 10, memBudgetMb: 4096, worldCostMb: 640, peerCostMb: 487,
    gatewayReserveMb: 256,
  });
  // 3840 usable after the reserve. At the old fixed price of 640 a world, that is 6.
  assert.equal(sup.capacity().cap, 6);

  assert.ok(sup.ensure('a', 'private', 'ann'));
  const a0 = spawned[0]!;
  const port = Number(a0.args[a0.args.indexOf('--port') + 1]);
  peers.set(port, 4); // four occupied cells in one world -> four engines
  await sup.poll();

  // 640 + 3x487 = 2101 committed by ONE world, leaving 1739 -> two more at 640.
  assert.deepEqual(
    { cap: sup.capacity().cap, reason: sup.capacity().reason },
    { cap: 3, reason: 'memory' },
    'a four-peer world must not be priced as a one-peer world',
  );

  assert.ok(sup.ensure('b', 'private', 'bob'));
  assert.ok(sup.ensure('c', 'private', 'cid'));
  assert.equal(sup.ensure('d', 'private', 'dan'), null, 'refused by RAM the peers already spent');
});

// NEGATIVE CONTROL. Identical sequence with peerCostMb at 0 -- the documented opt-out that
// restores the old whole-world arithmetic -- and the extra peers cost nothing again, so the cap
// stays at 6 and the fourth world is admitted. Make committedMb() ignore peerCount and the test
// above reports 6 and fails while this one still passes, which is the discrimination that
// matters: it separates "the governor prices peers" from "the harness ran out of ports".
test('capacity: peerCostMb 0 prices every world at worldCostMb however many peers it runs', async () => {
  const { sup, spawned, peers } = harness({
    maxWorlds: 10, memBudgetMb: 4096, worldCostMb: 640, peerCostMb: 0,
    gatewayReserveMb: 256,
  });
  assert.equal(sup.capacity().cap, 6);

  assert.ok(sup.ensure('a', 'private', 'ann'));
  const a0 = spawned[0]!;
  const port = Number(a0.args[a0.args.indexOf('--port') + 1]);
  peers.set(port, 4);
  await sup.poll();

  assert.equal(sup.capacity().cap, 6, 'opted out, so the extra peers are free');
  assert.ok(sup.ensure('b', 'private', 'bob'));
  assert.ok(sup.ensure('c', 'private', 'cid'));
  assert.ok(sup.ensure('d', 'private', 'dan'), 'the world the priced-peers run refused');
});

// The governor's INPUTS have to be visible, or the only evidence a box is filling up is the
// 503 a player gets when it is already full. worlds_running cannot carry that on its own any
// more: a world is one process whether its players share a cell or are scattered across four,
// and those two cost wildly different amounts of RAM.
test('observability: peers and committed RAM track what the worlds actually report', async () => {
  const { sup, spawned, peers } = harness({
    maxWorlds: 10, memBudgetMb: 4096, worldCostMb: 640, peerCostMb: 487,
    gatewayReserveMb: 256,
  });
  assert.deepEqual({ peers: sup.peersRunning, mb: sup.committed }, { peers: 0, mb: 0 },
    'an empty gateway has committed nothing');

  assert.ok(sup.ensure('a', 'private', 'ann'));
  // Before any poll: priced as the one peer worldCostMb already includes, not as free.
  assert.deepEqual({ peers: sup.peersRunning, mb: sup.committed }, { peers: 1, mb: 640 });

  const a0 = spawned[0]!;
  peers.set(Number(a0.args[a0.args.indexOf('--port') + 1]), 4);
  await sup.poll();
  assert.deepEqual({ peers: sup.peersRunning, mb: sup.committed }, { peers: 4, mb: 640 + 487 * 3 },
    'four engines in one world must show as four, and be priced as four');
});

// A world that has not answered /status yet is charged FULL price, not nothing. It is starting,
// crashed, or wedged -- in every case its memory is spent or about to be, and a guard that reads
// the unknown as free is not a guard. Without a poll there is no lastStatus at all, so this is
// also the path every freshly created world takes for its first few seconds.
test('capacity: a world with no status yet still costs its budget', () => {
  const { sup } = harness({
    maxWorlds: 10, memBudgetMb: 2304, worldCostMb: 640, peerCostMb: 487,
    gatewayReserveMb: 256,
  });
  assert.equal(sup.capacity().cap, 3); // 2048 usable / 640
  assert.ok(sup.ensure('a', 'private', 'ann'));
  assert.ok(sup.ensure('b', 'private', 'bob'));
  assert.ok(sup.ensure('c', 'private', 'cid'));
  assert.equal(sup.ensure('d', 'private', 'dan'), null, 'unpolled worlds are not free');
});
