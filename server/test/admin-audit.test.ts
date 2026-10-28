// OT3-183: every command through Admin.exec leaves a durable row, refusals included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminAudit } from '../src/core/admin-audit';
import { Admin } from '../src/core/admin';
import type { Player } from '../src/core/players';

test('audit rows survive a reopen and carry actor, target, args, reason, outcome', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  const audit = new AdminAudit(dir);
  const admin = new Admin({ audit, allow: () => true, motd: () => '', setMotd: () => {} } as never);
  const mod = { id: 1, name: 'Mod', accountKey: 'acct-mod', rank: 0 } as Player;
  await admin.exec(mod, 'kick', ['Bob', 'spamming', 'trade']);
  const rows = new AdminAudit(dir).recent();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actor, 'acct-mod');
  assert.equal(rows[0]!.cmd, 'kick');
  assert.equal(rows[0]!.target, 'Bob');
  assert.equal(rows[0]!.reason, 'spamming trade');
  assert.equal(rows[0]!.outcome, 'refused');
});
