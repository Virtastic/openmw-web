// OT3-186: login history records, finds shared addresses, and prunes past retention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoginLog, LOGIN_RETENTION_MS } from '../src/core/admin-audit';

test('login history: recent, shared address, retention', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logins-'));
  const log = new LoginLog(dir);
  const now = Date.now();
  log.record('Main', 'Hero', '10.0.0.1', now - LOGIN_RETENTION_MS - 1); // stale; pruned by the next write
  log.record('Main', 'Hero', '10.0.0.1', now);
  log.record('Alt', 'Sneak', '10.0.0.1', now);
  log.record('Other', 'Bob', '10.0.0.2', now);
  const rows = log.recent('main');
  assert.equal(rows.length, 1, 'the stale row was pruned');
  assert.equal(rows[0]!.character, 'Hero');
  assert.deepEqual(log.sharingIp('main').map((r) => ({ ...r })), [{ account: 'alt', ip: '10.0.0.1' }]);
  assert.deepEqual(new LoginLog(dir).recent('alt').map((r) => r.ip), ['10.0.0.1'], 'durable across instances');
});
