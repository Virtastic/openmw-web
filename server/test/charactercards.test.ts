// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The dashboard's account list shows each multiplayer character: name, level, where.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerStore, readCharacterCards } from '../src/persist/playerstore';
import { tmpDataDir } from './helpers';

test('a character card reads name, level and last cell off disk, and skips unknown ids', async () => {
  const dir = tmpDataDir();
  assert.equal(readCharacterCards(dir, ['c-1']).size, 0, 'no players.db yet is no characters');

  const world = new PlayerStore(dir, 'w1');
  world.update('c-1', (d) => {
    d.appearance = { name: 'Vinsoth' } as never;
    d.stats = { level: 5 };
    d.inventory = [{ id: 'gold_001', n: 10 }];
    d.position = { cellKey: 'Balmora', x: 0, y: 0, z: 0 };
  });
  await world.flushAll();
  await world.close();

  const cards = readCharacterCards(dir, ['c-1', 'c-missing']);
  assert.deepEqual(cards.get('c-1'), { name: 'Vinsoth', level: 5, cell: 'Balmora' });
  assert.equal(cards.has('c-missing'), false);
});
