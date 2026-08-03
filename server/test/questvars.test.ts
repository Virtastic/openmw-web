// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// chargenstate must never be stored or restored. GlobalVarSync applies stored values
// UNCONDITIONALLY (quests.lua MP_GlobalVarSync) — there is no monotonicity check, because
// quest globals legitimately move both ways. chargenstate counts DOWN to -1 ("creation
// finished"), so no ordering rule can protect it: a rejoin wrote an older value back over a
// finished tutorial and the Census door correctly refused to let the player out. Reported as
// "I gave the item and clicked duties, and it still says I have to do it."
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir, readPlayerDoc } from './helpers';

test('chargenstate is never stored, and never restored to a rejoining player', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false,
    dataDir, port: 0, host: '127.0.0.1',
    configOverride: { limits: { maxConnsPerIp: 16 } },
  });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  const { welcome } = await a.joinAsNew('Tutorial');
  const charId = String(welcome['characterId']);
  await a.waitEvent('PlayerList');
  await a.waitEvent('JournalSync');

  // Mid-tutorial value, then a normal quest global alongside it as the control.
  a.sendEvent('GlobalVarUpdate', { name: 'chargenstate', value: 4 });
  a.sendEvent('GlobalVarUpdate', { name: 'FreedSlavesCounter', value: 3 });
  await new Promise((r) => setTimeout(r, 300));
  a.close();
  await a.closed;
  await server.flush();

  const globals = (readPlayerDoc(dataDir, charId)?.['globals'] ?? {}) as Record<string, number>;
  assert.equal(globals['FreedSlavesCounter'], 3, 'the control global must still be shadowed');
  assert.equal(globals['chargenstate'], undefined,
    'chargenstate was stored — a rejoin will roll the tutorial back');

  // Rejoin: the sync must carry the control and nothing else.
  const b = await TestClient.connect(server.port);
  b.hello();
  await b.waitJson('SessionHelloOk');
  b.login('Tutorial', 'hunter22');
  await b.waitJson('SessionWelcome');
  b.sendJson({ t: 'SessionReady' });
  await b.waitEvent('PlayerList');
  const sync = await b.waitEvent('GlobalVarSync', () => true, 8000);
  const sent = JSON.stringify(sync.value);
  assert.ok(sent.includes('FreedSlavesCounter'), 'the control global must be restored: ' + sent);
  assert.ok(!/chargenstate/i.test(sent),
    'chargenstate was restored to the client — this is the Census duties blocker: ' + sent);
  b.close();
});
