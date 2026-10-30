// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-146 / OT3-97: a levelled spawn takes the LOWEST avatar level in ITS OWN cell, never a
// world-wide party level. Source-grep (the engine is C++; the harness covers the behaviour).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ACT = join(ROOT, 'openmw', 'apps', 'openmw', 'mwmechanics', 'actors.cpp');
const LEV = join(ROOT, 'openmw', 'apps', 'openmw', 'mwclass', 'creaturelevlist.cpp');
const skip = existsSync(ACT) ? false : 'no openmw/ tree here (the server image)';

test('nearestAvatarLevel is per cell, lowest level, with no world-wide party override', { skip }, () => {
  const src = readFileSync(ACT, 'utf8');
  const body = src.slice(src.indexOf('int Actors::nearestAvatarLevel'), src.indexOf('void Actors::rest('));
  assert.match(body, /const MWWorld::CellStore\* cell/);
  assert.match(body, /body\.getCell\(\) == cell/);
  assert.match(body, /lvl < level/);
  assert.doesNotMatch(body, /partyLevel/);
});

test('levelled creature spawns pass their own cell to the level lookup', { skip }, () => {
  const src = readFileSync(LEV, 'utf8');
  assert.match(src, /nearestAvatarLevel\(\s*ptr\.getRefData\(\)\.getPosition\(\)\.asVec3\(\), ptr\.getCell\(\)\)/);
});
