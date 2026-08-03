// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The sim peer runs the SERVER's own game data, so its content list is the world's truth.
// It used to be CHECKED before it was allowed to pin that list — so a client connecting
// first installed its own list (tier-1 adopt-first), the peer was measured against that
// stranger's list, failed BAD_CONTENT, and disabled itself permanently. The world was then
// left with no authority at all, judging every later player by whoever arrived first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContentGate } from '../src/core/manifest';

const entry = (name: string, idx: number) => ({ name, size: 0, idx });

test('the peer defines the world even when a client got there first', () => {
  const gate = new ContentGate('names');

  // A client arrives first and its list is adopted (tier 1).
  assert.equal(gate.check([entry('Morrowind.esm', 0)]).ok, true);
  assert.equal(gate.isAuthoritative, false);

  // The peer arrives with the world's real content. It PINS, then passes its own check.
  const real = [entry('Morrowind.esm', 0), entry('Tribunal.esm', 1), entry('Bloodmoon.esm', 2)];
  gate.setAuthoritative(real);
  assert.equal(gate.isAuthoritative, true);
  assert.equal(gate.check(real).ok, true, 'the peer is never refused by its own world');

  // And from here players are measured against the WORLD, not against the first stranger.
  assert.equal(gate.check([entry('Morrowind.esm', 0)]).ok, false);
});

test('content file names compare case-insensitively', () => {
  const gate = new ContentGate('names');
  gate.setAuthoritative([entry('Morrowind.esm', 0), entry('Tribunal.esm', 1)]);
  // Same files, the case a player's filesystem happens to report. This used to produce the
  // self-contradicting "missing Morrowind.esm; extra content: morrowind.esm".
  assert.equal(gate.check([entry('morrowind.esm', 0), entry('TRIBUNAL.ESM', 1)]).ok, true);
});
