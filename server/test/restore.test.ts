// OT3-184: per-character snapshots and point-in-time restore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlayerStore } from '../src/persist/playerstore';
import { AdminAudit } from '../src/core/admin-audit';
import { Admin } from '../src/core/admin';
import type { Player } from '../src/core/players';

const MIN = 60_000;

test('restore puts one character back to a snapshot and leaves everyone else alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'restore-'));
  const store = new PlayerStore(dir);
  let t = 1_000_000_000_000;
  store.now = () => t;
  const gold = (k: string) => store.getCached(k)?.inventory?.find((i) => i.id === 'gold_001')?.n;

  store.update('bob', (d) => { d.inventory = [{ id: 'gold_001', n: 10 }]; });
  store.update('ann', (d) => { d.inventory = [{ id: 'gold_001', n: 5 }]; });
  await store.flushAll();
  t += 5 * MIN; // inside the snapshot interval: no second snapshot
  store.update('bob', (d) => { d.inventory = [{ id: 'gold_001', n: 50 }]; });
  await store.flushAll();
  t += 60 * MIN;
  store.update('bob', (d) => { d.inventory = [{ id: 'gold_001', n: 99 }]; });
  store.update('ann', (d) => { d.inventory = [{ id: 'gold_001', n: 7 }]; });
  await store.flushAll();

  assert.equal(store.restoreTo('bob', t - 70 * MIN), undefined, 'nothing that old');
  assert.equal(store.restoreTo('bob', t - 30 * MIN), t - 65 * MIN);
  assert.equal(gold('bob'), 10);
  assert.equal(gold('ann'), 7);
  // The pre-restore state was snapshotted: the restore can be undone.
  assert.ok(store.restoreTo('bob', t));
  assert.equal(gold('bob'), 99);
  await store.close();
});

test('/restore disconnects the target first, restores, and writes an audit row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'restore-admin-'));
  const order: string[] = [];
  const bob = { id: 2, name: 'Bob', accountKey: 'bob', charId: 'bob#1', rank: 0,
    peer: { disconnect: () => order.push('disconnect') } } as unknown as Player;
  const audit = new AdminAudit(dir);
  const admin = new Admin({
    audit, allow: () => true, motd: () => '', setMotd: () => {},
    roster: { findByName: (n: string) => (n.toLowerCase() === 'bob' ? bob : undefined) },
    resume: { revokeAccount: () => order.push('revoke') },
    restore: (key: string) => { order.push(`restore ${key}`); return 123; },
  } as never);
  const staff = { id: 1, name: 'Admin', accountKey: 'staff', rank: 2 } as Player;
  const reply = await admin.exec(staff, 'restore', ['Bob', '60', 'duped', 'gold']);
  assert.match(String(reply), /Restored Bob/);
  assert.deepEqual(order, ['disconnect', 'revoke', 'restore bob#1']);
  const row = audit.recent()[0]!;
  assert.equal(row.cmd, 'restore');
  assert.equal(row.target, 'Bob');
  assert.equal(row.outcome, 'ok');
  assert.equal(await admin.exec({ ...staff, rank: 1 } as Player, 'restore', ['Bob', '60']) !== reply, true);
});
