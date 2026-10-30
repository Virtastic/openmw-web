// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-196: deploy/mp-health.py reports region handoffs and phase shifts, and no longer has a
// world reap / world switch section. Run against a test log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('mp-health.py: handoff and phase-shift counts appear; no world reap/switch section', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mphealth-'));
  const log = join(dir, 'openmw-mp.log');
  const ts = new Date().toISOString();
  const line = (o: object) => JSON.stringify({ ts, level: 'info', ...o });
  writeFileSync(log, [
    line({ event: 'region.handoff', from: 'west', to: 'east', name: 'A' }),
    line({ event: 'region.handoff', from: 'west', to: 'east', name: 'B' }),
    line({ event: 'region.handoff', from: 'east', to: 'west', name: 'A' }),
    line({ event: 'phase.shift', from: '', to: 'blight' }),
    line({ event: 'world.reaped', reason: 'idle' }), // a stale v1 line: ignored, not reported
    line({ event: 'client.log', session: 's1', text: '[boot] switchMs=900 ' }),
  ].join('\n') + '\n');
  const out = execFileSync('python3', [join(process.cwd(), '..', 'deploy', 'mp-health.py'), '--log', log, '--hours', '1'],
    { encoding: 'utf8' });
  assert.match(out, /region handoffs[^\n]*\n\s+2\s+west -> east\n\s+1\s+east -> west/);
  assert.match(out, /phase shifts[^\n]*\n\s+1\s+base -> blight/);
  assert.ok(!/worlds reaped/.test(out) && !/world switches/.test(out) && !/worlds started/.test(out));
});
