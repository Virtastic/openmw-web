// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The file contract between the server and the updater container.
//
// Both sides only ever see files in the shared data dir, so the things worth pinning are
// the refusals (a hostile tag never reaches the file, a duplicate click never rewrites a
// pending request) and the tolerance (a garbage status file reads as nulls, never a 500).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { requestServerUpdate, updateStatus } from '../src/net/admin/update-server';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'updsrv-'));

test('a request writes the flag with tag, author and time', () => {
  const dir = tmp();
  const r = requestServerUpdate(dir, 'v1.3.0', 'alice');
  assert.deepEqual(r, { ok: true });
  const flag = JSON.parse(readFileSync(join(dir, 'update-requested'), 'utf8')) as
    { tag: string; by: string; at: string };
  assert.equal(flag.tag, 'v1.3.0');
  assert.equal(flag.by, 'alice');
  assert.ok(!Number.isNaN(Date.parse(flag.at)));
});

test('a hostile tag never reaches the filesystem', () => {
  const dir = tmp();
  for (const bad of ['$(rm -rf /)', 'v1.0.0; reboot', 'main', 'v' + 'a'.repeat(40), '']) {
    const r = requestServerUpdate(dir, bad, 'alice');
    assert.equal(r.ok, false, `accepted: ${bad}`);
  }
  assert.equal(updateStatus(dir).requested, null, 'nothing was written');
});

test('a second click while a request is fresh is refused, not a rewrite', () => {
  const dir = tmp();
  assert.equal(requestServerUpdate(dir, 'v1.3.0', 'alice').ok, true);
  const r = requestServerUpdate(dir, 'v1.4.0', 'bob');
  assert.equal(r.ok, false);
  assert.equal((r as { busy?: boolean }).busy, true);
  const flag = JSON.parse(readFileSync(join(dir, 'update-requested'), 'utf8')) as { tag: string };
  assert.equal(flag.tag, 'v1.3.0', 'the pending request is untouched');
});

test('a stale leftover flag does not block a new request', () => {
  const dir = tmp();
  assert.equal(requestServerUpdate(dir, 'v1.3.0', 'alice').ok, true);
  const flag = join(dir, 'update-requested');
  const old = new Date(Date.now() - 20 * 60 * 1000);
  utimesSync(flag, old, old);
  assert.equal(requestServerUpdate(dir, 'v1.4.0', 'bob').ok, true);
});

test('updateStatus: nothing on disk reads as dead agent and nulls', () => {
  const s = updateStatus(tmp());
  assert.deepEqual(s.agent, { alive: false, ready: false, reason: null, at: null });
  assert.equal(s.requested, null);
  assert.equal(s.status, null);
});

test('updateStatus: a fresh heartbeat is alive, an old one is not', () => {
  const dir = tmp();
  const hb = join(dir, 'update-agent.json');
  writeFileSync(hb, JSON.stringify({ at: new Date().toISOString(), ready: true, reason: '' }));
  assert.deepEqual(updateStatus(dir).agent.alive, true);
  assert.equal(updateStatus(dir).agent.ready, true);
  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(hb, old, old);
  assert.equal(updateStatus(dir).agent.alive, false, 'a stale heartbeat means not running');
});

test('updateStatus: garbage files read as nulls, never a throw', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'update-agent.json'), 'not json {{{');
  writeFileSync(join(dir, 'update-status.json'), '[1,2,3]');
  writeFileSync(join(dir, 'update-requested'), '');
  const s = updateStatus(dir);
  assert.equal(s.agent.ready, false);
  assert.equal(s.status, null);
  assert.equal(s.requested, null);
});

test('updateStatus surfaces the updater phases the dashboard renders', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'update-status.json'), JSON.stringify({
    phase: 'building', tag: 'v1.3.0', startedAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:01:00Z', error: '',
  }));
  const s = updateStatus(dir).status;
  assert.equal(s?.phase, 'building');
  assert.equal(s?.tag, 'v1.3.0');
  assert.equal(s?.error, null, 'an empty error string reads as no error');
});
