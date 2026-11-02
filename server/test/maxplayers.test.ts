// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-139: THE PLAYER CAP COMES FROM THE MEASURED CAPACITY, NOT A HARD 256.
//
// One region = one sim peer, and the peer is the ceiling, so the cap is (measured players per
// region) x (regions). Until the soak publishes that number (OT3-74 / OT3-209),
// measuredCapacityPerRegion is 0 and the old [server] maxPlayers (256) stays the cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, effectiveMaxPlayers } from '../src/config';
import { tmpDataDir } from './helpers';

function cfg(toml: string): ReturnType<typeof loadConfig> {
  const dir = tmpDataDir();
  writeFileSync(join(dir, 'config.toml'), toml, 'utf8');
  return loadConfig(dir);
}

const TWO_REGIONS = `
[[simPeer.regions]]
id = "vvardenfell-west"
rects = [[-30, -30, 0, 30]]
[[simPeer.regions]]
id = "vvardenfell-east"
rects = [[1, -30, 30, 30]]
`;

test('effectiveMaxPlayers: unmeasured falls back, measured scales with regions', () => {
  assert.equal(effectiveMaxPlayers(0, 1, 256), 256);
  assert.equal(effectiveMaxPlayers(0, 4, 256), 256, 'regions alone do not raise an unmeasured cap');
  assert.equal(effectiveMaxPlayers(-5, 1, 256), 256);
  assert.equal(effectiveMaxPlayers(Number.NaN, 1, 256), 256);
  assert.equal(effectiveMaxPlayers(100, 1, 256), 100);
  assert.equal(effectiveMaxPlayers(100, 3, 256), 300);
  assert.equal(effectiveMaxPlayers(100.9, 0, 256), 100, 'at least one region, whole players');
});

test('shipped defaults: nothing measured yet, so the cap is the 256 fallback', () => {
  const c = cfg('');
  assert.equal(c.server.measuredCapacityPerRegion, 0);
  assert.equal(c.server.maxPlayers, 256);
});

test('a measured capacity replaces maxPlayers (one region)', () => {
  const c = cfg('[server]\nmaxPlayers = 256\nmeasuredCapacityPerRegion = 80\n');
  assert.equal(c.server.maxPlayers, 80);
});

test('a measured capacity is per region: two regions double it', () => {
  const c = cfg('[server]\nmeasuredCapacityPerRegion = 80\n' + TWO_REGIONS);
  assert.equal(c.server.maxPlayers, 160);
});

test('unmeasured with regions keeps the configured maxPlayers', () => {
  const c = cfg('[server]\nmaxPlayers = 120\n' + TWO_REGIONS);
  assert.equal(c.server.maxPlayers, 120);
});
