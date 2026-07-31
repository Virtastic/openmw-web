// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The peer must stand in the cluster it was spawned to simulate.
//
// It did not. `--new-game` sets mNewGame, engine.cpp calls newGame(!mNewGame), and
// worldimp.cpp only honours --start when that `bypass` argument is true — so passing
// --new-game made --start dead code and every peer booted into the character-creation cell.
// It held authority over the Imperial Prison Ship, an empty interior, while the cells players
// were actually standing in had no holder at all. Every RAM/CPU measurement taken before this
// was of a peer sitting in a tiny interior, not one simulating a 3x3 exterior block.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { SimPeerSupervisor } from '../src/core/simpeer';

class FakeChild extends EventEmitter {
  pid = 4242;
  kill(): boolean { return true; }
}

function harness() {
  const spawns: { key: string; args: string[] }[] = [];
  const sup = new SimPeerSupervisor({
    settings: {
      enabled: true, binary: '/fake/openmw', configDir: '/cfg', userDataDir: '/ud',
      startCell: 'Seyda Neen', maxPeers: 4, idleReapMs: 120_000,
      startTimeoutMs: 60_000, restartBackoffMs: 1000,
    },
    wsUrl: () => 'ws://127.0.0.1:9000/ws',
    password: 'peer-secret',
    spawner: (key, _env, args) => { spawns.push({ key, args }); return new FakeChild() as unknown as ChildProcess; },
  });
  return { sup, spawns };
}

test('the peer is started IN its cluster anchor, not at a fixed default cell', () => {
  const { sup, spawns } = harness();
  sup.ensure('-2,-9', { cellKey: '-2,-9', x: 100, y: 200, z: 0 });
  assert.equal(spawns.length, 1);
  const args = spawns[0]!.args;
  const start = args[args.indexOf('--start') + 1];
  assert.equal(start, '-2,-9',
    'the anchor cell must be passed to --start; findExteriorPosition parses "x,y" directly');
});

test('--new-game is never passed: it silently disables --start', () => {
  const { sup, spawns } = harness();
  sup.ensure('3,4', { cellKey: '3,4', x: 0, y: 0, z: 0 });
  assert.ok(!spawns[0]!.args.includes('--new-game'),
    '--new-game makes bypass false, and --start is only honoured when bypass is true');
  assert.ok(spawns[0]!.args.includes('--skip-menu'), 'the peer must still skip the menu');
});

test('with no anchor it falls back to the configured start cell', () => {
  const { sup, spawns } = harness();
  sup.ensure('lonely');
  const args = spawns[0]!.args;
  assert.equal(args[args.indexOf('--start') + 1], 'Seyda Neen');
});
