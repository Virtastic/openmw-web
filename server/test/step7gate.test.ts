// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Step 7 gate (OT3-56/59/62/113): two players on one quest at different stages both finish it
// without affecting each other. Journal, story global and NPC local flag are all per character;
// the peer's dummy is neutral (server/docs/PEER-DUMMY-PLAYER.md): a peer write with no charId
// credits nobody's journal that does not already hold the quest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir, readPlayerDoc } from './helpers';

const NPC = { __refnum: { index: 777, contentFile: 0 } };

test('two players at different stages of one quest both finish it independently', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: { limits: { maxConnsPerIp: 16 } } });
  t.after(() => server.close());
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  const idA = String((await a.joinAsNew('StageA')).welcome['characterId']);
  const idB = String((await b.joinAsNew('StageB')).welcome['characterId']);
  await a.waitEvent('PlayerList');
  await b.waitEvent('PlayerList');
  for (const c of [a, b]) { c.sendCellChange('0,0', 0, 0, 0); await c.waitEvent('PlayerCellChange'); }

  const Q = 'ms_fargothring';
  a.sendEvent('JournalEntry', { questId: Q, index: 10 });
  b.sendEvent('JournalEntry', { questId: Q, index: 50 });
  a.sendEvent('GlobalVarUpdate', { name: 'fargothring_state', value: 1 });
  b.sendEvent('GlobalVarUpdate', { name: 'fargothring_state', value: 5 });
  a.sendEvent('MemberVarUpdate', { ref: NPC, name: 'talked', value: 1, cellKey: '0,0' });
  // A finishes first, B follows later; neither write may move the other.
  a.sendEvent('JournalEntry', { questId: Q, index: 100 });
  const text = `fence-${Math.random().toString(36).slice(2)}`;
  a.sendEvent('ChatSend', { text: `!${text}` });
  await b.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === text);
  b.sendEvent('JournalEntry', { questId: Q, index: 100 });
  b.sendEvent('ChatSend', { text: `!${text}b` });
  await a.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === `${text}b`);

  for (const c of [a, b]) {
    assert.equal(c.inbox.events.filter((e) => ['JournalEntry', 'GlobalVarUpdate', 'MemberVarUpdate'].includes(e.name)).length, 0,
      'no quest state is relayed between players');
  }
  await new Promise((r) => setTimeout(r, 200));
  await server.flush();
  const da = readPlayerDoc(dataDir, idA) as { journal?: Record<string, number>; globals?: Record<string, number> };
  const db = readPlayerDoc(dataDir, idB) as { journal?: Record<string, number>; globals?: Record<string, number> };
  assert.equal(da.journal?.[Q], 100);
  assert.equal(db.journal?.[Q], 100);
  assert.equal(da.globals?.['fargothring_state'], 1, "A's story global stayed A's");
  assert.equal(db.globals?.['fargothring_state'], 5, "B's story global stayed B's");
});
