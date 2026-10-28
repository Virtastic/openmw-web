// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 3 PvP zoning: wilderness-only PvP, safe cells, interiors always safe, and the
// party friendly-fire exemption. Asserted through the plugin gate itself, which is the
// single place the decision is made.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pvp } from '../src/plugins/builtin/pvp';
import type { PluginApi } from '../src/plugins/api';
import type { Config } from '../src/config';

function api(opts: {
  pvp?: boolean;
  zone?: 'all' | 'wilderness' | 'none';
  safeCells?: string[];
  cell?: string;
  attackerCell?: string;
  levels?: Record<number, number>;
}): PluginApi {
  return {
    config: {
      rules: {
        pvp: opts.pvp ?? true,
        pvpZone: opts.zone ?? 'all',
        safeCells: opts.safeCells ?? [],
      },
    } as unknown as Config,
    log: () => {},
    cellOfPlayer: (id: number) => (id === 1 && opts.attackerCell !== undefined ? opts.attackerCell : opts.cell),
    ...(opts.levels ? { levelOfPlayer: (id: number) => opts.levels![id] ?? 1 } : {}),
  } as unknown as PluginApi;
}

const attacker = { id: 1, name: 'Alice', rank: 0 };
const hit = (a: PluginApi) => pvp.onPlayerHit?.(a, attacker, 2, 'CombatHit');

test('pvp disabled blocks everything, zone none blocks even in the wild', () => {
  assert.equal(hit(api({ pvp: false })), false);
  assert.equal(hit(api({ zone: 'none', cell: '12,4' })), false);
});

test('wilderness zone: exteriors allow, interiors and safe cells refuse', () => {
  assert.equal(hit(api({ zone: 'wilderness', cell: '12,4' })), true, 'open country is hot');
  assert.equal(hit(api({ zone: 'wilderness', cell: '-3,-18' })), true, 'negative coords are still exterior');
  assert.equal(hit(api({ zone: 'wilderness', cell: 'Balmora, Eight Plates' })), false,
    'you must be able to stand still in a tavern');
  assert.equal(hit(api({ zone: 'wilderness', cell: '12,4', safeCells: ['12,4'] })), false,
    'an operator-declared safe cell overrides the wilderness rule');
});

test('wilderness zone fails CLOSED when the cell is unknown', () => {
  assert.equal(hit(api({ zone: 'wilderness', cell: undefined })), false,
    'an unknown location must never be a free hit');
});


test('zone "all" keeps the pre-Phase-3 behaviour', () => {
  assert.equal(hit(api({ zone: 'all', cell: 'Some Interior' })), true);
});

// OT3-162: onboarding protection holds under every zoning, 'all' included.
test('no player damage in Seyda Neen, either side of the hit', () => {
  assert.equal(hit(api({ cell: '-2,-9' })), false, 'the census office street');
  assert.equal(hit(api({ cell: 'Seyda Neen, Arrille\'s Tradehouse' })), false);
  assert.equal(hit(api({ cell: '12,4', attackerCell: '-3,-9' })), false, 'nor shooting out of it');
  assert.equal(hit(api({ cell: '12,4' })), true);
});

test('sprouts below level 5 neither take nor deal player damage', () => {
  assert.equal(hit(api({ cell: '12,4', levels: { 1: 20, 2: 4 } })), false, 'a level-4 victim');
  assert.equal(hit(api({ cell: '12,4', levels: { 1: 3, 2: 20 } })), false, 'a level-3 attacker');
  assert.equal(hit(api({ cell: '12,4', levels: {} })), false, 'unknown stats count as level 1');
  assert.equal(hit(api({ cell: '12,4', levels: { 1: 5, 2: 5 } })), true);
});
