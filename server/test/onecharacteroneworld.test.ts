// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// ONE CHARACTER, ONE WORLD. Inside a process the newcomer wins (SUPERSEDED). Across worlds
// nothing enforced it: the same character in two tabs, in two worlds, was two sessions
// flushing one doc last-writer-wins -- an inventory from one under a position from the
// other. The shared presence row is the arbiter: the world that sees another world's newer
// row for a player it holds drops that session on its next heartbeat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

test('opening the character in a second world drops the session in the first', async (t) => {
  const sharedDir = mkdtempSync(join(tmpdir(), 'omw-shared-'));
  const opts = { requireGameData: false, port: 0, host: '127.0.0.1', sharedDir, presenceMs: 300,
    configOverride: { login: { allowHarnessAuth: true } } as never };
  const a = await startServer({ ...opts, dataDir: tmpDataDir(), worldId: 'world-a' });
  t.after(() => a.close());
  const b = await startServer({ ...opts, dataDir: tmpDataDir(), worldId: 'world-b' });
  t.after(() => b.close());

  const inA = await TestClient.connect(a.port);
  t.after(() => inA.close());
  await inA.joinAsNew('Twin', 'hunter22');
  await inA.waitEvent('PlayerList');
  await new Promise((r) => setTimeout(r, 400)); // a heartbeat: A's row is written

  const inB = await TestClient.connect(b.port);
  t.after(() => inB.close());
  await inB.joinExisting('Twin', 'hunter22');
  await inB.waitEvent('PlayerList');
  await inA.waitDisconnect('SUPERSEDED');
  // The newcomer keeps playing: B's own heartbeat must not read its own row as foreign.
  await new Promise((r) => setTimeout(r, 700));
  inB.sendEvent('ChatSend', { text: 'still here' });
  await inB.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'still here');
});

// A BAN REACHES EVERY WORLD. /ban in world A wrote the shared list and kicked A's roster; a
// guest sitting in world B played on until they next disconnected. Every world checks its
// roster against the shared list on its heartbeat.
test('an account banned in one world is dropped from another within a heartbeat', async (t) => {
  const { BanStore } = await import('../src/persist/banstore');
  const sharedDir = mkdtempSync(join(tmpdir(), 'omw-shared-'));
  const opts = { requireGameData: false, port: 0, host: '127.0.0.1', sharedDir, presenceMs: 300,
    configOverride: { login: { allowHarnessAuth: true } } as never };
  const b = await startServer({ ...opts, dataDir: tmpDataDir(), worldId: 'world-b' });
  t.after(() => b.close());
  const guest = await TestClient.connect(b.port);
  t.after(() => guest.close());
  await guest.joinAsNew('Pest', 'hunter22');
  await guest.waitEvent('PlayerList');
  new BanStore(sharedDir).banAccount('pest', 'admin', 'griefing'); // what /ban in world A writes
  await guest.waitDisconnect('BANNED');
});
