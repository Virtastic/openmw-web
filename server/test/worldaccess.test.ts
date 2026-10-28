// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// One world (OT3-31): no door but capacity. The cap the operator sets is the one advertised.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

test('the advertised player cap is the number the operator set, and the one enforced', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { maxPlayers: 64 } },
  });
  t.after(() => server.close());

  const status = await (await fetch(`http://127.0.0.1:${server.port}/status`)).json() as
    { maxPlayers: number };
  assert.equal(status.maxPlayers, 64,
    'the operator asked for 64 seats; advertising anything else means the number shown is not'
    + ' the number enforced, which is the gap a full world used to fill with "this world is private"');
});
