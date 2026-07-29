// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// A world that empties must forget a runtime mode flip. The gateway reuses a RUNNING world
// as-is, so without this, flipping your world to party once left it joinable forever and every
// later session silently rejoined a party world instead of the solo one it asked for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

test('a private world reverts to private once the last player leaves', async (t) => {
  const server = await startServer({
    dataDir: tmpDataDir(), port: 0, host: '127.0.0.1', worldMode: 'private',
  });
  t.after(() => server.close());

  const c = await TestClient.connect(server.port);
  await c.joinAsNew('Owner');
  await c.waitEvent('PlayerList');
  await server.api.world.promoteOwner('Owner'); // owner may flip
  c.sendEvent('SetWorldMode', { mode: 'party' });
  const flip = await c.waitEvent('SocialResult', (v) => (v as { op?: string }).op === 'SetWorldMode');
  assert.equal((flip.value as { ok?: boolean }).ok, true, 'owner could not flip to party');

  c.close();
  await c.closed;

  // Rejoining must land in a SOLO world, not the party one left behind.
  const c2 = await TestClient.connect(server.port);
  c2.hello();
  await c2.waitJson('SessionHelloOk');
  c2.login('Owner', 'hunter22');
  await c2.waitJson('SessionWelcome');
  c2.sendJson({ t: 'SessionReady' });
  await c2.waitEvent('PlayerList');
  c2.sendEvent('SetWorldMode', { mode: 'party' });
  const again = await c2.waitEvent('SocialResult', (v) => (v as { op?: string }).op === 'SetWorldMode');
  assert.equal((again.value as { ok?: boolean }).ok, true,
    'flipping again failed — the world did not revert to private when it emptied');
  c2.close();
});
