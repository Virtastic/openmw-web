// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// THE CHARGEN SANCTUARY. The sim peer must never simulate the Imperial Prison Ship or the
// Census and Excise Office.
//
// Morrowind's opening is driven entirely by its own mwscripts on the actors in those rooms,
// and the engine writes `chargenstate` exactly once — every step toward -1 is those scripts
// running on the PLAYER's machine. The peer boots past creation (chargenstate -1), so the
// moment it holds one of those cells the client attaches puppets over the chargen actors and
// disables their AI: the scripts then only run in the peer's world, where the tutorial is
// already over, and character creation stalls forever. Unheld is the correct state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isChargenCell, parseExterior } from '../src/core/movement';

// The rule simPeerTick applies when building its anchor list.
function anchorCells(occupied: string[]): string[] {
  return [...new Set(occupied)].sort().filter((c) => !isChargenCell(c));
}

test('the chargen cells are recognised, in the casing the client actually sends', () => {
  for (const c of [
    'Imperial Prison Ship',
    'imperial prison ship',
    'Seyda Neen, Census and Excise Office',
    'seyda neen, census and excise office',
  ]) assert.equal(isChargenCell(c), true, `${c} must be sanctuary`);
});

test('ordinary cells are not', () => {
  for (const c of ['-2,-9', 'Balmora, Council Club', 'Seyda Neen, Arrille\'s Tradehouse', '']) {
    assert.equal(isChargenCell(c), false, `${c} must not be sanctuary`);
  }
  assert.equal(isChargenCell(undefined), false);
});

test('a player in chargen produces NO anchor, so nothing holds their cell', () => {
  assert.deepEqual(anchorCells(['Imperial Prison Ship']), []);
  assert.deepEqual(anchorCells(['Seyda Neen, Census and Excise Office']), []);
});

test('other players are still simulated while someone is in chargen', () => {
  // The sanctuary is per-cell, not a global stop: everyone else keeps their simulation.
  assert.deepEqual(
    anchorCells(['Imperial Prison Ship', '-2,-9', 'Balmora, Council Club']),
    ['-2,-9', 'Balmora, Council Club'],
  );
});

test('exterior anchors still parse after filtering', () => {
  const cells = anchorCells(['Imperial Prison Ship', '3,4']);
  assert.deepEqual(cells.map(parseExterior).filter(Boolean), [{ x: 3, y: 4 }]);
});
