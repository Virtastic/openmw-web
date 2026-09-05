// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase H4: the sim-peer supervisor. Driven with a FAKE spawner and an injected clock, so
// the reaper — the part that decides whether per-session peers are affordable or an OOM —
// is asserted directly instead of by waiting minutes for a real engine to idle out.
import test from 'node:test';
// The peer's only credential; an empty [server].password refuses every system connection.
const PEER_PASS = 'peer-secret-1';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { SimPeerSupervisor, peerAccountName, type SimPeerSettings } from '../src/core/simpeer';

class FakeChild extends EventEmitter {
  killed: string[] = [];
  pid = 4242;
  kill(sig: string): boolean {
    this.killed.push(sig);
    // A real SIGTERM'd process exits; the supervisor's bookkeeping depends on that.
    queueMicrotask(() => this.emit('exit', 0, sig));
    return true;
  }
}

const SETTINGS: SimPeerSettings = {
  enabled: true,
  binary: '/fake/openmw',
  configDir: '/fake/cfg',
  userDataDir: '/fake/user',
  startCell: 'Seyda Neen',
  maxPeers: 2,
  idleReapMs: 60_000,
  startTimeoutMs: 120_000,
  restartBackoffMs: 15_000,
};

// A process exit is asynchronous in reality and in the fake, so a test that asserts on
// post-exit bookkeeping must yield first. Asserting synchronously would be asserting on a
// timing the OS does not offer.
const tick = () => new Promise((r) => setImmediate(r));

function harness(over: Partial<SimPeerSettings> = {}) {
  const spawned: { key: string; env: NodeJS.ProcessEnv; args: string[]; child: FakeChild }[] = [];
  let clock = 1_000_000;
  const sup = new SimPeerSupervisor({
    settings: { ...SETTINGS, ...over },
    wsUrl: () => 'ws://127.0.0.1:9/ws',
    password: 'pw',
    now: () => clock,
    spawner: (key, env, args) => {
      const child = new FakeChild();
      spawned.push({ key, env, args, child });
      return child as unknown as ChildProcess;
    },
  });
  return { sup, spawned, advance: (ms: number) => { clock += ms; } };
}

test('sim peer: spawned with the flags that make it a headless system client', () => {
  const { sup, spawned } = harness();
  sup.ensure('world');
  assert.equal(spawned.length, 1);
  const { env, args } = spawned[0]!;
  // These three are the whole contract with the engine; a typo in any of them produces a
  // peer that renders, or one that shows up in the player list, and both are silent.
  assert.equal(env.OPENMW_HEADLESS, '1', 'must not render');
  assert.equal(env.OPENMW_MP_SYSTEM, '1', 'must be invisible as a participant');
  assert.equal(env.OPENMW_MP_URL, 'ws://127.0.0.1:9/ws', 'must dial back into this server');
  assert.ok(args.includes('--replace'), 'must isolate its config from any user openmw.cfg');
});

test('sim peer: ensure is idempotent — humans arriving repeatedly do not fork engines', () => {
  const { sup, spawned } = harness();
  sup.ensure('world');
  sup.ensure('world');
  sup.ensure('world');
  assert.equal(spawned.length, 1, 'one peer per world, not one per join');
  assert.equal(sup.running, 1);
});

// MULTI-PEER COVERAGE. This is a multiplayer server: players are routinely in different cells,
// and a peer only ticks actors within 7168 units of where it stands against an 8192-wide cell.
// SPILL-VALVE MACHINERY. The live server runs ONE peer covering every occupied cell
// (server.ts simPeerPass); the supervisor's multi-key support is kept as the spill valve if
// the scale ramp ever demands more than one process. This pins that the machinery works.
test('sim peer: several keyed engines can run at once (spill valve)', () => {
  const { sup, spawned } = harness();
  // Cold starts are SERIALISED (one retail data load at a time), so the second cell starts on
  // the next pass rather than alongside the first. Both still get an engine, which is the
  // property this test is about; noteHello stands in for the first peer finishing its load.
  sup.ensure('-2,-9', { cellKey: '-2,-9', x: 1, y: 2, z: 3 });
  sup.noteHello('-2,-9');
  sup.ensure('0,-9', { cellKey: '0,-9', x: 4, y: 5, z: 6 });
  assert.equal(spawned.length, 2, 'two occupied cells need two engines');
  // Each boots INTO its own cell (--start), which is what makes it simulate that cell rather
  // than merely load it.
  const started = spawned.map((sp) => sp.args[sp.args.indexOf('--start') + 1]);
  assert.deepEqual(started.sort(), ['-2,-9', '0,-9']);
  assert.deepEqual(sup.keys().sort(), ['-2,-9', '0,-9']);
});

// A cell key is not a legal account name -- '-2,-9' carries a comma, interiors carry spaces --
// but the peer still has to log in, and the server has to map the connected system player BACK
// to the cell it covers in order to send it the right anchor and grant it the right authority.
// Getting this wrong is silent: the peer connects, matches nothing, and simulates nowhere.
test('sim peer: the account name is legal and maps back to its cell', () => {
  const { sup, spawned } = harness();
  sup.ensure('-2,-9', { cellKey: '-2,-9', x: 0, y: 0, z: 0 });
  const name = spawned[0]!.env.OPENMW_MP_NAME!;
  assert.ok(!/[^A-Za-z0-9_-]/.test(name), `account name must be charset-legal, got ${name}`);
  assert.equal(name, peerAccountName('-2,-9'));
  assert.equal(sup.keyOfAccount(name), '-2,-9', 'must resolve back to the cell it simulates');
});

test('sim peer: an interior gets a legal name too, and still maps back', () => {
  const { sup, spawned } = harness();
  sup.ensure('Balmora, Council Club', { cellKey: 'Balmora, Council Club', x: 0, y: 0, z: 0 });
  const name = spawned[0]!.env.OPENMW_MP_NAME!;
  assert.ok(!/[^A-Za-z0-9_-]/.test(name), `got ${name}`);
  assert.equal(sup.keyOfAccount(name), 'Balmora, Council Club');
});

// A CAPPED PEER IS A BROKEN CELL, NOT SHED LOAD. Every occupied cell needs its own engine to
// be simulated at all, so refusing one hands that player frozen NPCs and melee that never
// lands while every health check still reads green. maxPeers = 0 means unlimited and is the
// shipped default; capacity is meant to run out at world CREATION, which refuses visibly.
test('sim peer: maxPeers 0 means unlimited (spill valve sizing)', () => {
  const { sup, spawned } = harness({ maxPeers: 0 });
  const cells = ['-2,-9', '-1,-9', '0,-9', '1,-9', '2,-9', 'Balmora, Council Club'];
  // Cold starts are serialised -- one retail data load at a time -- so this drives the queue the
  // way the supervisor's own caller does: each pass starts the next cell once the previous peer
  // has reported hello. The property under test is that NO CELL IS LEFT WITHOUT ONE, which is
  // about coverage and not about how many engines may load simultaneously.
  for (const c of cells) {
    sup.ensure(c, { cellKey: c, x: 0, y: 0, z: 0 });
    sup.noteHello(c);
  }
  assert.equal(spawned.length, cells.length, 'no cell may be left without a simulator');
  assert.deepEqual(sup.keys().sort(), [...cells].sort());
});

test('sim peer: the cap is enforced, and refusing is not a crash', () => {
  const { sup, spawned } = harness({ maxPeers: 2 });
  sup.ensure('a');
  sup.noteHello('a');
  sup.ensure('b');
  sup.noteHello('b');
  sup.ensure('c');
  sup.noteHello('c'); // over the cap
  assert.equal(spawned.length, 2, 'the third world gets no peer');
  assert.equal(sup.running, 2);
  // Refusal must be survivable: that world falls back to client authority, which still works.
  assert.ok(!sup.has('c'));
});

test('sim peer: an idle world is reaped, a busy one is not', async () => {
  const { sup, spawned, advance } = harness();
  sup.ensure('busy');
  sup.noteHello('busy');
  sup.ensure('idle');
  sup.noteHello('idle');
  sup.markIdle('idle');

  advance(30_000); // less than idleReapMs
  sup.sweep();
  assert.equal(sup.running, 2, 'nothing is reaped before its deadline');

  advance(31_000); // now past 60s idle
  sup.sweep();
  await tick(); // the reaped child's exit lands on the next turn
  assert.equal(sup.running, 1, 'the idle world is reaped');
  assert.ok(sup.has('busy'), 'the busy world keeps its peer');
  assert.deepEqual(spawned[1]!.child.killed, ['SIGTERM'],
    'reaped cleanly, so the server releases authority through the normal leave path');
});

test('sim peer: a player returning before the deadline cancels the reap', async () => {
  const { sup, advance } = harness();
  sup.ensure('world');
  sup.markIdle('world');
  advance(50_000);
  sup.ensure('world'); // someone came back
  advance(30_000); // would have been past the ORIGINAL deadline (50s + 30s > 60s)
  sup.sweep();
  await tick(); // without this the assertion reads state before any kill could land, and
                // passes even when the cancel is removed — verified by negative control.
  assert.equal(sup.running, 1, 'the reap must be cancelled, not merely delayed');
});

test('sim peer: a crash backs off instead of hot-looping', () => {
  const { sup, spawned, advance } = harness();
  sup.ensure('world');
  spawned[0]!.child.emit('exit', 1, null); // crashed, not stopped
  assert.equal(sup.running, 0);

  sup.ensure('world'); // immediate retry
  assert.equal(spawned.length, 1, 'a crashed peer is not respawned immediately');

  advance(15_001); // past restartBackoffMs
  sup.ensure('world');
  assert.equal(spawned.length, 2, 'but it does come back after the backoff');
});

test('sim peer: disabled means nothing is ever spawned', () => {
  const { sup, spawned } = harness({ enabled: false });
  sup.ensure('world');
  assert.equal(spawned.length, 0, 'a self-hoster without game data must be unaffected');
  assert.equal(sup.running, 0);
});

test('sim peer: a stale exit cannot reap the peer that replaced it', async () => {
  const { sup, spawned, advance } = harness();
  sup.ensure('world');
  const first = spawned[0]!.child;
  sup.stop('world');
  await tick(); // let the stop actually complete before starting a replacement
  advance(20_000); // past the backoff so ensure() may start a fresh one
  sup.ensure('world');
  assert.equal(spawned.length, 2, 'a new peer started');
  // The OLD process's exit event arrives late (kill() already queued one; fire another).
  first.emit('exit', 0, 'SIGTERM');
  await tick();
  assert.equal(sup.running, 1, "a dead peer's exit must not delete its successor");
  assert.ok(sup.has('world'));
});

test('sim peer: its account is ephemeral — no player doc is ever written', async () => {
  const { startServer } = await import('../src/server');
  const { TestClient, tmpDataDir, listPlayerDocKeys } = await import('./helpers');
  const { existsSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');

  const dir = tmpDataDir();
  const server = await startServer({ requireGameData: false, configOverride: { server: { password: PEER_PASS } }, dataDir: dir, port: 0, host: '127.0.0.1' });
  try {
    const peer = await TestClient.connect(server.port);
    peer.system = true;
    peer.serverPassword = PEER_PASS;
    await peer.joinAsNew('simpeer_world');
    peer.sendCellChange('5,5', 1, 2, 3); // the kind of update that would normally persist
    await peer.waitEvent('ActorAuthorityGrant', () => true, 5000);

    const human = await TestClient.connect(server.port);
    const { welcome } = await human.joinAsNew('realplayer');
    const humanCharId = welcome['characterId'] as string; // docs are keyed by character id
    human.sendCellChange('5,5', 1, 2, 3);
    await new Promise((r) => setTimeout(r, 200));

    await server.flush();
    const files = listPlayerDocKeys(dir);
    assert.ok(!files.some((f: string) => f.startsWith('simpeer_world')),
      `a sim peer must leave no player doc, found: ${files.join(', ')}`);
    // Control: the HUMAN in the same run is still persisted, so this proves the peer is
    // excluded rather than persistence being broken outright.
    assert.ok(files.includes(humanCharId),
      `a real player must still be persisted, found: ${files.join(', ')}`);
    peer.ws.close();
    human.ws.close();
  } finally {
    await server.close();
  }
});

test('sim peer: a content refusal is TERMINAL, not a crash to retry', async () => {
  // The live bug this fixes: a peer whose data disagrees with the world is refused at hello,
  // exits, and restartBackoffMs respawns it forever at ~360 MB a time — while players sit
  // with frozen NPCs and only a `warn` explains it. Retrying cannot fix a misconfiguration.
  const { sup, spawned, advance } = harness();
  sup.ensure('world');
  assert.equal(spawned.length, 1);

  sup.disablePermanently('BAD_CONTENT: your game is missing Tribunal.esm');
  await tick();
  assert.equal(sup.running, 0, 'the running peer is stopped');
  assert.match(String(sup.disabledReason), /Tribunal\.esm/,
    'the reason is kept so an operator can see WHY simulation is off');

  // No amount of time or re-ensuring brings it back.
  advance(60_000);
  sup.ensure('world');
  sup.ensure('world');
  assert.equal(spawned.length, 1, 'a permanently disabled peer is never respawned');
});

test('sim peer: one wedged before hello is reaped, one that reported hello is not', async () => {
  // Without a start deadline a peer that never comes up sits there indefinitely holding
  // ~360 MB: the idle reaper only counts players, and the crash backoff only fires on an
  // EXIT that never arrives.
  const { sup, spawned, advance } = harness({ startTimeoutMs: 30_000 });
  // Cold starts are serialised, so 'healthy' is started FIRST and reaches hello; only then does
  // 'wedged' get its slot. Same end state -- one peer up, one stuck before hello -- reached the
  // way the supervisor now actually gets there.
  sup.ensure('healthy');
  sup.noteHello('healthy'); // only this one reaches hello
  sup.ensure('wedged');
  assert.equal(spawned.length, 2);

  advance(10_000);
  sup.sweep();
  await tick();
  assert.equal(sup.running, 2, 'nothing is reaped before the deadline');

  advance(21_000); // past 30s since start
  sup.sweep();
  await tick();
  assert.ok(sup.has('healthy'), 'a peer that reported hello is left alone');
  assert.ok(!sup.has('wedged'), 'a peer that never reached hello is stopped');
});

// ---------------------------------------------------------------- cold-start serialisation
//
// Peers are one per OCCUPIED CELL, so a player crossing a few cells asks for several at once. A
// peer loading retail data reaches hello in ~11 s alone; several contend for disk and CPU and
// take far longer, and the sweeper SIGKILLs any that has not said hello inside startTimeoutMs.
// They therefore die seconds before they would have been ready, the cell is left with no
// authority, and the next pass starts the same race again.
//
// Observed live, not theorised: `simpeer.start_timeout waitedMs=120577` next to
// `simpeer.crashed signal=SIGKILL`, then `cells_unsimulated` for the cell the player stood in.
// To the player that is enemies aggroing and then freezing, and melee that never lands.
test('simpeer: only one peer cold-starts at a time', () => {
  const { sup, spawned } = harness({ maxPeers: 0 });

  sup.ensure('0,0');
  assert.equal(spawned.length, 1, 'the first cell starts immediately');

  // A second occupied cell while the first is still starting must WAIT, not pile on.
  sup.ensure('0,-9');
  assert.equal(spawned.length, 1, 'a second cold start must be deferred, not run concurrently');

  // Once the first is ready, the queue moves.
  sup.noteHello('0,0');
  sup.ensure('0,-9');
  assert.equal(spawned.length, 2, 'the deferred cell starts once the first peer is ready');
});

// NEGATIVE CONTROL. Deferral must be temporary — a cell that waited has to start on a later
// pass, or this trades a thrash for a permanent coverage hole, which is strictly worse: the
// player gets frozen NPCs either way but nothing ever recovers.
test('simpeer: a deferred cell is not forgotten', () => {
  const { sup, spawned } = harness({ maxPeers: 0 });
  sup.ensure('0,0');
  sup.ensure('1,1');
  assert.equal(spawned.length, 1);
  sup.noteHello('0,0');
  sup.ensure('1,1');   // the caller's next beat
  assert.equal(spawned.length, 2, 'the retry must succeed rather than stay blocked');
});

// THE ENGINE IGNORES SIGTERM. Measured in the harness on 2026-09-02 and again on 2026-09-04
// (six ~360 MB peers from finished scenarios still running an hour later). A child that only
// dies on SIGKILL is therefore the realistic one; the three tests below hold the supervisor to
// what production actually needs from it.
function ignoresTerm(child: FakeChild): void {
  child.kill = (sig: string) => {
    child.killed.push(sig);
    if (sig === 'SIGKILL') queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
    return true;
  };
}
const withShortGrace = async (fn: () => Promise<void>): Promise<void> => {
  const was = SimPeerSupervisor.STOP_GRACE_MS;
  SimPeerSupervisor.STOP_GRACE_MS = 20;
  try { await fn(); } finally { SimPeerSupervisor.STOP_GRACE_MS = was; }
};
const settle = () => new Promise((r) => setTimeout(r, 80)); // past the 20 ms grace, plus the exit turn

test('sim peer: a peer that ignores SIGTERM is SIGKILLed after the grace', () => withShortGrace(async () => {
  const { sup, spawned } = harness();
  sup.ensure('world');
  ignoresTerm(spawned[0]!.child);
  sup.stop('world');
  assert.deepEqual(spawned[0]!.child.killed, ['SIGTERM'], 'TERM first: a clean leave is still the preferred path');
  assert.equal(sup.running, 1, 'still bookkept until it actually exits');
  await settle();
  assert.deepEqual(spawned[0]!.child.killed, ['SIGTERM', 'SIGKILL']);
  assert.equal(sup.running, 0, 'the exit handler ran, so the entry is gone');
}));

test('sim peer: a reaped zombie does not block the world from ever getting a peer again', () => withShortGrace(async () => {
  // The production shape of the bug: idle reap -> SIGTERM ignored -> entry stuck as
  // `stopping` -> ensure() sees "existing" and returns -> that world never gets a peer again,
  // and the zombie counts against maxPeers for everyone else.
  const { sup, spawned, advance } = harness();
  sup.ensure('world');
  sup.noteHello('world');
  ignoresTerm(spawned[0]!.child);
  sup.markIdle('world');
  advance(61_000);
  sup.sweep(); // reaps: SIGTERM, which this engine ignores
  sup.ensure('world'); // a player is back before anything exited
  assert.equal(spawned.length, 1, 'while the old one is still alive there is nothing to do but wait');
  await settle(); // ... the escalation fires and the zombie exits
  advance(20_000); // clear any crash backoff, as a real return would
  sup.ensure('world');
  assert.equal(spawned.length, 2, 'once the zombie is gone the world gets a fresh peer');
}));

test('sim peer: shutdown SIGKILLs outright -- nobody is left to receive a clean leave', async () => {
  const { sup, spawned } = harness();
  sup.ensure('a');
  sup.noteHello('a'); // only one peer STARTS at a time; 'b' is refused until 'a' is up
  sup.ensure('b');
  ignoresTerm(spawned[0]!.child);
  sup.stopAll();
  assert.deepEqual(spawned[0]!.child.killed, ['SIGKILL']);
  assert.deepEqual(spawned[1]!.child.killed, ['SIGKILL']);
  await tick();
  assert.equal(sup.running, 0, 'a server that has exited leaves no engine behind');
});
