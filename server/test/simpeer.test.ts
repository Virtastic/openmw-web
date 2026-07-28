// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase H4: the sim-peer supervisor. Driven with a FAKE spawner and an injected clock, so
// the reaper — the part that decides whether per-session peers are affordable or an OOM —
// is asserted directly instead of by waiting minutes for a real engine to idle out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { SimPeerSupervisor, type SimPeerSettings } from '../src/core/simpeer';

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

test('sim peer: the cap is enforced, and refusing is not a crash', () => {
  const { sup, spawned } = harness({ maxPeers: 2 });
  sup.ensure('a');
  sup.ensure('b');
  sup.ensure('c'); // over the cap
  assert.equal(spawned.length, 2, 'the third world gets no peer');
  assert.equal(sup.running, 2);
  // Refusal must be survivable: that world falls back to client authority, which still works.
  assert.ok(!sup.has('c'));
});

test('sim peer: an idle world is reaped, a busy one is not', async () => {
  const { sup, spawned, advance } = harness();
  sup.ensure('busy');
  sup.ensure('idle');
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
  const { TestClient, tmpDataDir } = await import('./helpers');
  const { existsSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');

  const dir = tmpDataDir();
  const server = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1' });
  try {
    const peer = await TestClient.connect(server.port);
    peer.system = true;
    await peer.joinAsNew('simpeer_world');
    peer.sendCellChange('5,5', 1, 2, 3); // the kind of update that would normally persist
    await peer.waitEvent('ActorAuthorityGrant', () => true, 5000);

    const human = await TestClient.connect(server.port);
    await human.joinAsNew('realplayer');
    human.sendCellChange('5,5', 1, 2, 3);
    await new Promise((r) => setTimeout(r, 200));

    await server.flush();
    const playersDir = join(dir, 'players');
    const files = existsSync(playersDir) ? readdirSync(playersDir) : [];
    assert.ok(!files.some((f) => f.startsWith('simpeer_world')),
      `a sim peer must leave no player doc, found: ${files.join(', ')}`);
    // Control: the HUMAN in the same run is still persisted, so this proves the peer is
    // excluded rather than persistence being broken outright.
    assert.ok(files.some((f) => f.startsWith('realplayer')),
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
  sup.ensure('wedged');
  sup.ensure('healthy');
  assert.equal(spawned.length, 2);

  sup.noteHello('healthy'); // only this one reaches hello

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
