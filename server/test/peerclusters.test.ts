// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// ONE PEER PER CLUSTER OF PLAYERS. A peer simulates only the 3x3 block it has loaded, so a
// single peer parked at a fixed start cell left everyone more than one cell away watching
// frozen NPCs — their cell had no holder at all, and nothing said so. Players standing
// together share a peer; players in different parts of the world each need one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadedCells } from '../src/core/movement';

// The clustering rule the server tick applies, in isolation: first player anchors a cluster,
// later players join whichever cluster already covers them.
function clustersFor(cells: string[]): string[] {
  const anchors: string[] = [];
  for (const cell of cells) {
    if (anchors.some((a) => loadedCells(a).includes(cell))) continue;
    anchors.push(cell);
  }
  return anchors;
}

test('a peer claims ONLY the cell it stands in', () => {
  // Not the 3x3 it has loaded. OpenMW clamps actor processing to 7168 units and a cell is
  // 8192 wide, so a peer cannot tick actors across a neighbouring cell — claiming one would
  // give it a holder that never simulates it, which is a silent freeze rather than a visibly
  // unheld cell.
  assert.deepEqual(loadedCells('0,0'), ['0,0']);
  assert.ok(!loadedCells('0,0').includes('1,1'), 'a neighbour is outside the processing range');
});

test('an interior is its own island', () => {
  assert.deepEqual(loadedCells('Balmora, Council Club'), ['Balmora, Council Club']);
});

test('players in the SAME cell share one peer', () => {
  assert.deepEqual(clustersFor(['-2,-9', '-2,-9', '-2,-9']), ['-2,-9']);
});

test('players in adjacent cells each need their own peer', () => {
  // They look co-located, and a naive footprint would fold them into one peer — but that peer
  // could only actually simulate one of the two cells.
  assert.deepEqual(clustersFor(['-2,-9', '-1,-9']), ['-2,-9', '-1,-9']);
});

test('players in different parts of the world each need a peer', () => {
  // Seyda Neen, Balmora, and an interior: three unrelated places.
  const anchors = clustersFor(['-2,-9', '-3,-2', 'Balmora, Council Club']);
  assert.equal(anchors.length, 3,
    'three separated groups need three peers — one cannot simulate them all');
});

test('every distinct cell is its own cluster', () => {
  // Getting this wrong is exactly the silent-frozen-NPC bug: a peer credited with a cell it
  // cannot reach with its actor processing radius.
  assert.deepEqual(clustersFor(['0,0', '1,0', '2,0']), ['0,0', '1,0', '2,0']);
});
