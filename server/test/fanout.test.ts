// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-59: no world-wide fan-out for appearance, equipment and map. Only the clock and weather
// stay shared. A look goes to the people who can see the player, and to whoever comes into view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const src = (f: string): string => readFileSync(join(process.cwd(), 'src', f), 'utf8');

test('grep-checked: no inWorld fan-out for appearance, equipment, map or kills', () => {
  const ps = src('core/playerstate.ts');
  assert.equal(/relayAll\(/.test(ps), false, 'playerstate.ts has no relayAll');
  for (const m of ["'PlayerAppearance'", "'PlayerEquipment'"]) {
    for (const line of ps.split('\n').filter((l) => l.includes(`relayToViewers(`) && l.includes(m))) {
      assert.ok(line.includes('relayToViewers'), line);
    }
  }
  const m7 = src('core/m7.ts');
  assert.equal(/inWorld\(\)[^\n]*\n[^\n]*WorldMapExplored/.test(m7), false, 'map exploration is not fanned out');
  assert.equal(/sendEvent\('WorldMapExplored'/.test(m7), false);
  const ws = src('core/worldstate.ts');
  assert.equal(/inWorld\(\)\) p\.peer\.sendEvent\('WorldKillCount'/.test(ws), false, 'kills are per character');
});

test('a look reaches viewers only, and whoever comes into view gets it', async (t) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { limits: { maxConnsPerIp: 16 } } });
  t.after(() => server.close());
  const mk = async (name: string, cell: string) => {
    const c = await TestClient.connect(server.port);
    t.after(() => c.close());
    const { playerId } = await c.joinAsNew(name);
    await c.waitEvent('PlayerList');
    c.sendCellChange(cell, 0, 0, 0);
    await c.waitEvent('PlayerCellChange');
    return { c, playerId };
  };
  const a = await mk('LookA', '0,0');
  const near = await mk('LookNear', '0,0');
  const far = await mk('LookFar', '40,40');
  a.c.sendEvent('PlayerAppearance', { race: 'dark elf', head: 'h', hair: 'x', isMale: true, class: 'warrior', name: 'LookA' });
  a.c.sendEvent('PlayerEquipment', { slots: new Map<number, string>([[0, 'iron_helmet']]) });
  const isA = (v: unknown): boolean => (v as { id?: number }).id === a.playerId;
  await near.c.waitEvent('PlayerAppearance', isA, 3000);
  await near.c.waitEvent('PlayerEquipment', isA, 3000);
  const text = `fence-${Math.random().toString(36).slice(2)}`;
  a.c.sendEvent('ChatSend', { text, channel: 'global' });
  await far.c.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === text);
  assert.equal(far.c.inbox.events.filter((e) => (e.name === 'PlayerAppearance' || e.name === 'PlayerEquipment') && isA(e.value)).length, 0,
    'a player across the map is not told how A looks');

  // Far walks into view of A and is handed the look then.
  far.c.sendCellChange('0,1', 0, 0, 0);
  await far.c.waitEvent('PlayerAppearance', isA, 3000);
  await far.c.waitEvent('PlayerEquipment', isA, 3000);
});
