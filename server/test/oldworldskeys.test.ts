// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-49: the per-world [worlds] table is gone. An old config.toml still carrying it loads,
// and the server says once that the table is ignored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { onLog } from '../src/log';
import { tmpDataDir } from './helpers';

test('an old [worlds] table loads and is reported as ignored', () => {
  const dir = tmpDataDir();
  writeFileSync(join(dir, 'config.toml'),
    '[worlds]\nmaxWorlds = 4\nmemBudgetMb = 8192\npeerCostMb = 487\nidleReapSec = 60\nownerAwayKeepSec = 30\nloadCap = 8\n', 'utf8');
  const events: string[] = [];
  const off = onLog((e) => events.push(e.event));
  try {
    const cfg = loadConfig(dir);
    assert.equal((cfg as unknown as Record<string, unknown>).worlds, undefined);
  } finally { off(); }
  assert.ok(events.includes('config.ignored_worlds'));
});
