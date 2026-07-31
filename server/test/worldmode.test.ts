// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The client must never GUESS which world it is in. The Solo/Party/Public switcher used to
// render from a localStorage note of what was last clicked — it survived reloads and
// reconnects, so the panel could assert "Public" while the connection was to the player's
// own world, and no amount of clicking fixed it. The server states the world's mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

test('the server tells a joining client what the world is', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: 'public' });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Modey');
  const m = await a.waitEvent('WorldMode');
  assert.equal((m.value as { mode: string }).mode, 'public');
});
