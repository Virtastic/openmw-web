// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// H2: a new account's first [limits] probationHours: it hands nothing to anyone in the shared
// world (no drops, no container puts) and chats at one line per 5 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

async function boot(t: test.TestContext, probationHours: number) {
  delete process.env.OMW_NO_PROBATION; // helpers.ts turns probation off for every other test
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { economy: { noDrop: true }, limits: { probationHours } } });
  process.env.OMW_NO_PROBATION = '1';
  t.after(() => server.close());
  const c = await TestClient.connect(server.port);
  await c.joinAsNew('Fresh');
  await c.waitEvent('PlayerList');
  c.sendCellChange('0,0', 0, 0, 0);
  await c.waitEvent('PlayerCellChange');
  c.sendEvent('PlayerInventory', { items: [{ id: 'iron_dagger', n: 2 }] });
  await new Promise((r) => setTimeout(r, 200));
  return c;
}

const drop = (c: TestClient, tempId: number) => {
  c.sendEvent('ObjectSpawnRequest', {
    tempId, recordId: 'iron_dagger', cellKey: '0,0', x: 1, y: 2, z: 3, rotZ: 0, count: 1 });
  return c.waitEvent('ObjectSpawnAck', (v) => (v as { tempId?: number }).tempId === tempId, 2500).catch(() => null);
};
const told = (c: TestClient, re: RegExp) => c.waitEvent('ChatMessage', (v) => {
  const m = v as { channel?: string; text?: string };
  return m.channel === 'server' && re.test(m.text ?? '');
}, 3000);

test('H2: a new account cannot drop into the shared world and is told why', async (t) => {
  const c = await boot(t, 24);
  const toldDrop = told(c, /first day/);
  assert.equal(await drop(c, 1), null, 'a probation account dropped into the shared world');
  await toldDrop;
  c.close();
});

test('H2: a new account chats at most one line per 5 s past a burst of 3', async (t) => {
  const c = await boot(t, 24);
  const toldChat = told(c, /every 5 seconds/);
  for (let i = 0; i < 6; i++) c.sendEvent('ChatSend', { text: `hi ${i}` });
  await toldChat;
  c.close();
});

test('OT3-23: a new account cannot post to global chat and is told why', async (t) => {
  const c = await boot(t, 24);
  const toldGlobal = told(c, /cannot use global chat/);
  c.sendEvent('ChatSend', { channel: 'global', text: 'hello everyone' });
  await toldGlobal;
  c.close();
});

test('H2: probationHours = 0 turns probation off', async (t) => {
  const c = await boot(t, 0);
  assert.ok(await drop(c, 2), 'with probation off a fresh account drops normally');
  c.close();
});
