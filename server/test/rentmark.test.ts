// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-56 (B4): inn rent globals and the Mark/Recall spot are one character's. Two players rent
// different rooms and Mark different spots; each doc holds only its own, nothing is relayed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir, readPlayerDoc } from './helpers';

test('rent globals and the Mark spot are per character', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: { limits: { maxConnsPerIp: 16 } } });
  t.after(() => server.close());
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  const idA = String((await a.joinAsNew('Renter')).welcome['characterId']);
  const idB = String((await b.joinAsNew('Marker')).welcome['characterId']);
  await a.waitEvent('PlayerList');
  await b.waitEvent('PlayerList');

  a.sendEvent('GlobalVarUpdate', { name: 'rent_room_balmora', value: 1 });
  b.sendEvent('GlobalVarUpdate', { name: 'rent_room_balmora', value: 2 });
  a.sendEvent('PlayerMark', { cell: 'Balmora, Eight Plates', x: 1, y: 2, z: 3 });
  b.sendEvent('PlayerMark', { cell: 'Caldera, Guild of Mages', x: 4, y: 5, z: 6 });
  const text = `fence-${Math.random().toString(36).slice(2)}`;
  a.sendEvent('ChatSend', { text, channel: 'global' });
  await b.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === text);
  b.sendEvent('ChatSend', { text: `${text}2`, channel: 'global' });
  await a.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === `${text}2`);
  assert.equal(a.inbox.events.filter((e) => e.name === 'GlobalVarUpdate' || e.name === 'PlayerMark').length, 0);
  assert.equal(b.inbox.events.filter((e) => e.name === 'GlobalVarUpdate' || e.name === 'PlayerMark').length, 0);

  await new Promise((r) => setTimeout(r, 200));
  await server.flush();
  const da = readPlayerDoc(dataDir, idA) as { globals?: Record<string, number>; mark?: { cell: string } };
  const db = readPlayerDoc(dataDir, idB) as { globals?: Record<string, number>; mark?: { cell: string } };
  assert.equal(da.globals?.['rent_room_balmora'], 1);
  assert.equal(db.globals?.['rent_room_balmora'], 2);
  assert.equal(da.mark?.cell, 'Balmora, Eight Plates');
  assert.equal(db.mark?.cell, 'Caldera, Guild of Mages');
});
