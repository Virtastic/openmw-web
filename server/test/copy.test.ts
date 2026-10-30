// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-61: no player-facing tour or launcher text speaks of owners, guests, private/solo worlds
// or switching worlds: there is one shared world.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(process.cwd(), '..');
const FORBIDDEN = /\b(owner|guests?|private world|solo world|your own world|switch(ing)? worlds?)\b|<b>Solo<\/b>/i;

test('tour and launcher copy describe one shared world', () => {
  const index = readFileSync(join(root, 'play', 'index.html'), 'utf8');
  const tours = index.slice(index.indexOf('TOURS.unlocked = ['), index.indexOf('var tourEl'));
  assert.ok(tours.length > 200, 'found the tour block');
  assert.equal(FORBIDDEN.test(tours), false, 'tour text');
  const launcher = readFileSync(join(root, 'play', 'launcher.html'), 'utf8');
  for (const m of launcher.matchAll(/<p class="cs-sub">([^<]*)<\/p>/g)) assert.equal(FORBIDDEN.test(m[1]!), false, m[1]);
  assert.match(tours, /same world/);
});
