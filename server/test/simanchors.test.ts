// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// ONE PEER, MANY ANCHORS — the thing that makes this scale.
//
// A peer can only simulate around a point: vanilla OpenMW keeps one grid of active cells
// centred on the player and unloads everything else, and gates actor processing on distance
// from the player. So covering players spread across the world used to cost one ~450 MB engine
// process PER occupied cell — 200 players in 40 places is 40 processes and ~18 GB, which is a
// wall, not a tuning problem.
//
// The engine now takes a LIST of anchors (Scene::setSimAnchors + nearest-anchor actor gating),
// so those 40 regions live in ONE process: the marginal cost of a region is its cells, not a
// whole second engine. This pins the server half — the anchor list itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExterior } from '../src/core/movement';

// The rule the server tick applies: one anchor per distinct occupied EXTERIOR cell, deduped
// and ordered so an unchanged roster produces an unchanged list.
function anchorsFor(cellKeys: string[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const cell of [...new Set(cellKeys)].sort()) {
    const e = parseExterior(cell);
    if (e) out.push({ x: e.x, y: e.y });
  }
  return out;
}

test('players in the same cell produce one anchor', () => {
  assert.deepEqual(anchorsFor(['-2,-9', '-2,-9', '-2,-9']), [{ x: -2, y: -9 }]);
});

test('players spread across the world each anchor their own region', () => {
  // The case that used to need three engine processes.
  assert.deepEqual(anchorsFor(['-2,-9', '3,4', '-15,2']),
    [{ x: -15, y: 2 }, { x: -2, y: -9 }, { x: 3, y: 4 }]);
});

test('200 players in 40 places is 40 anchors, in ONE peer', () => {
  const cells: string[] = [];
  for (let i = 0; i < 40; i++) for (let p = 0; p < 5; p++) cells.push(`${i},0`);
  const anchors = anchorsFor(cells);
  assert.equal(anchors.length, 40, 'one anchor per region, not one per player');
  // The point: this is a list handed to a single process, not a process count.
  assert.ok(anchors.every((a) => a.y === 0));
});

test('interiors are not anchored: the peer covers the one it stands in', () => {
  // parseExterior rejects them, so they never enter the list.
  assert.deepEqual(anchorsFor(['Balmora, Council Club', '0,0']), [{ x: 0, y: 0 }]);
});

test('the list is stable for an unchanged roster', () => {
  // The tick only resends on change, because the engine re-runs its cell grid when the list
  // moves — resending an identical list every 5s would churn cell loads for nothing.
  const a = JSON.stringify(anchorsFor(['3,4', '-2,-9']));
  const b = JSON.stringify(anchorsFor(['-2,-9', '3,4']));
  assert.equal(a, b, 'roster order must not change the anchor list');
});
