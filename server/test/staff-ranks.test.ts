// OT3-191: dashboard roles map to game ranks from the ACCOUNT, and staff act only below them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminAudit } from '../src/core/admin-audit';
import { Admin, dashboardRank, operatorRank, PLATFORM_ACTOR } from '../src/core/admin';
import type { Player } from '../src/core/players';

const accounts = {
  keyForUsername: (n: string) => n.toLowerCase(),
  get: async (k: string) => ({
    helper: { name: 'Helper', rank: 0, dashboardRole: 'moderator' },
    senior: { name: 'Senior', rank: 2, dashboardRole: 'moderator' },
    boss: { name: 'Boss', rank: 3, dashboardRole: 'owner' },
    viewer: { name: 'Viewer', rank: 2, dashboardRole: 'viewer' },
  } as Record<string, unknown>)[k],
};

test('dashboard roles map to ranks from the account, failing closed', async () => {
  assert.equal(dashboardRank('moderator'), 1);
  assert.equal(dashboardRank('moderator', 3), 2, 'moderator never reaches owner');
  assert.equal(dashboardRank('owner'), 3);
  assert.equal(dashboardRank('viewer', 2), 0);
  const r = (n: string) => operatorRank(accounts as never, n);
  assert.deepEqual(await Promise.all(['Helper', 'Senior', 'Boss', 'Viewer', 'ghost', '(shared-token)', PLATFORM_ACTOR].map(r)),
    [1, 2, 3, 0, 0, 1, 4]);
});

test('a moderator cannot kick a moderator; the platform kicks an owner', async () => {
  const kicked: string[] = [];
  const mk = (name: string, rank: number) =>
    ({ id: 1, name, accountKey: name.toLowerCase(), rank, peer: { disconnect: () => kicked.push(name) } }) as unknown as Player;
  const players = [mk('Mod2', 1), mk('Owner', 3)];
  const admin = new Admin({
    audit: new AdminAudit(mkdtempSync(join(tmpdir(), 'ranks-'))), allow: () => true,
    roster: { findByName: (n: string) => players.find((p) => p.name.toLowerCase() === n.toLowerCase()) },
  } as never);
  assert.match(await admin.exec(mk('Mod1', 1), 'kick', ['Mod2']), /not below your rank/);
  assert.match(await admin.exec(mk('Mod1', 1), 'ban', ['Mod2']), /requires rank 2/);
  assert.match(await admin.exec(mk('Mod1', 1), 'give', ['Mod2', 'gold_001', '5', 'x']), /requires rank 2/);
  assert.match(await admin.exec(mk(PLATFORM_ACTOR, 4), 'kick', ['Owner', 'account erased']), /^Kicked Owner/);
  assert.deepEqual(kicked, ['Owner']);
});
