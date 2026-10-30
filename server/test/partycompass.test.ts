// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-120: the HTML compass math (extracted from play/index.html and executed) and the
// party-frame markup wiring (OT3-114).

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const indexUrl = new URL('../../play/index.html', import.meta.url);
const opts = existsSync(indexUrl) ? {} : { skip: 'play/ is not part of the server image' };
const html = existsSync(indexUrl) ? readFileSync(indexUrl, 'utf8') : '';

test('compass math: bearing is relative to the facing, markers clamp to the strip', opts, () => {
  const m = /\/\*PARTYCOMPASS\*\/([\s\S]*?)\/\*END PARTYCOMPASS\*\//.exec(html);
  assert.ok(m, 'compass block present');
  const { partyBearing, compassSlot } = new Function(`${m[1]}; return { partyBearing, compassSlot };`)() as {
    partyBearing(a: object, b: object, yaw: number): { rel: number; dist: number };
    compassSlot(rel: number): { pct: number; edge: string };
  };
  const me = { x: 0, y: 0 };
  assert.equal(partyBearing(me, { x: 0, y: 700 }, 0).rel, 0, 'north of me, facing north: dead ahead');
  assert.equal(partyBearing(me, { x: 0, y: 700 }, 0).dist, 10);
  assert.ok(Math.abs(partyBearing(me, { x: 700, y: 0 }, 0).rel - Math.PI / 2) < 1e-9, 'east is to the right');
  assert.ok(Math.abs(partyBearing(me, { x: 700, y: 0 }, Math.PI / 2).rel) < 1e-9, 'facing east: east is ahead');
  assert.ok(Math.abs(Math.abs(partyBearing(me, { x: 0, y: -700 }, 0).rel) - Math.PI) < 1e-9, 'behind');
  assert.equal(compassSlot(0).pct, 50);
  assert.equal(compassSlot(0).edge, '');
  assert.equal(compassSlot(Math.PI).pct, 96, 'behind pins to the right edge with an arrow');
  assert.equal(compassSlot(-2).edge, '◀');
});

test('party frame markup is wired: region, bars as meters, fed by partyFrame', opts, () => {
  assert.match(html, /id="omw-party" role="region"/);
  assert.match(html, /role="meter"/);
  assert.match(html, /mpState\(\), rows = pj\(m\.partyFrame\)/);
});
