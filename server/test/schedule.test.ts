// OT3-190: a scheduled broadcast fires on time, survives a restart, and can be cancelled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Schedule, type ScheduledKind } from '../src/core/schedule';

test('schedule: fires when due, persists, cancels', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-'));
  const fired: [ScheduledKind, string][] = [];
  const fire = (k: ScheduledKind, t: string) => { fired.push([k, t]); };
  const now = Date.now();
  const a = new Schedule(dir, fire);
  a.add(now + 60_000, 'say', 'restart in 1 min', 'Admin');
  const gone = a.add(now + 60_000, 'say', 'never', 'Admin');
  a.add(now + 120_000, 'motd', 'Back soon', 'Admin');
  assert.ok(a.cancel(gone));
  a.tick(now);
  assert.deepEqual(fired, [], 'nothing early');

  const b = new Schedule(dir, fire); // "restart"
  assert.equal(b.list().length, 2);
  b.tick(now + 60_000);
  assert.deepEqual(fired, [['say', 'restart in 1 min']]);
  b.tick(now + 600_000); // late after downtime still fires, once
  b.tick(now + 600_000);
  assert.deepEqual(fired, [['say', 'restart in 1 min'], ['motd', 'Back soon']]);
  assert.equal(b.list().length, 0);
});
