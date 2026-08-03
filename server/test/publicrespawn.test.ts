// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// A public world that dies must come back on its own. It used to stay dead until the gateway
// was restarted, which meant the lobby advertised a world nobody could join.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { WorldSupervisor } from '../src/gateway/worlds';

class FakeChild extends EventEmitter {
  pid = Math.floor(Math.random() * 10000) + 2;
  kill(sig: string): boolean { queueMicrotask(() => this.emit('exit', 0, sig)); return true; }
}

test('a crashed public world is restarted by the next poll', async () => {
  const children: FakeChild[] = [];
  let spawnArgs: string[] = [];
  const worlds = new WorldSupervisor({
    settings: {
      worldsDir: mkdtempSync(join(tmpdir(), 'omw-resp-')), gatewayPort: 8080,
      serverEntry: '/fake/server.mjs', nodeBin: '/fake/node',
      basePort: 43000, maxWorlds: 5, idleReapMs: 60_000, startTimeoutMs: 1000,
      restartBackoffMs: 0, publicWorlds: ['vvardenfell'],
      sharedDir: mkdtempSync(join(tmpdir(), 'omw-resp-sh-')),
    },
    spawner: (_bin, args) => { spawnArgs = args; const c = new FakeChild(); children.push(c); return c as unknown as ChildProcess; },
    fetchStatus: async () => ({ playerCount: 0, connectedCount: 0, maxPlayers: 32, name: 'w' }),
  });
  worlds.startPublic();
  await worlds.poll();
  assert.ok(worlds.get('vvardenfell'), 'public world starts at boot');
  // A world with no --gateway has its world browser disabled, so clicking Public in game asks
  // for the world list, gets no_gateway, and silently never switches. Nothing else catches it:
  // the world starts fine and looks healthy.
  assert.ok(spawnArgs.includes('--gateway'), 'spawned worlds are told where the gateway is');

  // Die the way a killed process dies: an exit that was not requested by the supervisor.
  children[0]!.emit('exit', 0, '');
  assert.equal(worlds.get('vvardenfell'), undefined, 'crash removes it');

  await worlds.poll();
  assert.ok(worlds.get('vvardenfell'), 'the next poll brings it back');
  worlds.stopAll();
});
