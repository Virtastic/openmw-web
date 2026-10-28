// OT3-180..182: staff fixes on an offline character -- /unstick, /restoreitem, /quest set|clear.
// Each edit is on disk for the next login, lands in admin_audit, and an online target is
// disconnected first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlayerStore } from '../src/persist/playerstore';
import { AdminAudit } from '../src/core/admin-audit';
import { Admin } from '../src/core/admin';
import type { LedgerEntry } from '../src/core/trade';
import type { Player } from '../src/core/players';

const SAFE = { cellKey: 'Seyda Neen', x: 1, y: 2, z: 3 };

function setup(online?: Player) {
  const dir = mkdtempSync(join(tmpdir(), 'offline-staff-'));
  const store = new PlayerStore(dir);
  const audit = new AdminAudit(dir);
  const ledger: LedgerEntry[] = [];
  const cooldowns: string[] = [];
  const admin = new Admin({
    audit, allow: () => true, motd: () => '', setMotd: () => {},
    roster: { findByName: (n: string) => (online && n.toLowerCase() === online.name.toLowerCase() ? online : undefined) },
    resume: { revokeAccount: () => {} },
    questRepair: { clearSpawnCooldowns: (k: string) => cooldowns.push(k) },
    ledger: (e: LedgerEntry) => ledger.push(e),
    chars: {
      // The account "bob" plays bob#1; a raw charKey resolves to itself.
      resolve: async (who: string) => (who.toLowerCase() === 'bob' ? 'bob#1' : (await store.get(who)) ? who : undefined),
      edit: (k: string, fn: never) => store.update(k, fn, 'now'),
      safePoint: () => SAFE,
    },
  } as never);
  return { dir, store, audit, ledger, cooldowns, admin };
}

const staff = { id: 1, name: 'Admin', accountKey: 'staff', rank: 2 } as Player;

test('offline /unstick, /restoreitem and /quest land on disk for the next login', async () => {
  const { dir, store, audit, ledger, cooldowns, admin } = setup();
  store.update('bob#1', (d) => {
    d.position = { cellKey: 'Void', x: 9, y: 9, z: -9999 };
    d.inventory = [{ id: 'iron_dagger', n: 1 }];
    d.journal = { a1_1_findspymaster: 10, ms_fargoth_ring: 20 };
    d.journalLog = [{ q: 'MS_Fargoth_Ring', i: 20, d: 1, m: 1, dm: 1 } as never];
  });
  await store.flushAll();

  assert.match(String(await admin.exec(staff, 'unstick', ['Bob', 'fell', 'through', 'floor'])), /Moved Bob to Seyda Neen/);
  assert.match(String(await admin.exec(staff, 'restoreitem', ['Bob', 'Iron_Dagger', '2', 'lost', 'to', 'a', 'crash'])), /Restored 2x iron_dagger/);
  assert.match(String(await admin.exec(staff, 'restoreitem', ['bob#1', 'gold_001', '50', 'refund'])), /Restored 50x gold_001/);
  assert.match(String(await admin.exec(staff, 'quest', ['set', 'Bob', 'A1_1_FindSpymaster', '30'])), /Set Bob's a1_1_findspymaster to 30/);
  assert.match(String(await admin.exec(staff, 'quest', ['clear', 'Bob', 'ms_fargoth_ring'])), /Cleared/);
  assert.match(String(await admin.exec(staff, 'unstick', ['nobody', 'x'])), /No character/);
  await store.close();

  // The next login reads a fresh store.
  const after = await new PlayerStore(dir).get('bob#1');
  assert.deepEqual(after?.position, SAFE);
  assert.deepEqual(after?.inventory, [{ id: 'iron_dagger', n: 3 }, { id: 'gold_001', n: 50 }]);
  assert.deepEqual(after?.journal, { a1_1_findspymaster: 30 });
  assert.deepEqual(after?.journalLog, []);

  assert.deepEqual(cooldowns, ['bob#1', 'bob#1']);
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0]!.a.name, 'Admin');
  assert.deepEqual(ledger[0]!.b, { char: 'bob#1', name: 'Bob', gave: [] });
  assert.match(ledger[0]!.reason!, /lost to a crash/);
  const cmds = audit.recent().map((r) => r.cmd).sort();
  assert.deepEqual(cmds, ['quest', 'quest', 'restoreitem', 'restoreitem', 'unstick', 'unstick']);
});

test('an online target is disconnected before the edit; ranks are respected', async () => {
  const order: string[] = [];
  const bob = { id: 2, name: 'Bob', accountKey: 'bob', charId: 'bob#1', rank: 0,
    peer: { disconnect: () => order.push('disconnect') } } as unknown as Player;
  const { store, admin } = setup(bob);
  await admin.exec(staff, 'unstick', ['Bob', 'stuck']);
  assert.deepEqual(order, ['disconnect']);
  assert.deepEqual(store.getCached('bob#1')?.position, SAFE);
  const mod = { ...staff, rank: 1 } as Player;
  assert.doesNotMatch(String(await admin.exec(mod, 'restoreitem', ['Bob', 'gold_001', '5', 'x'])), /Restored/);
  assert.match(String(await admin.exec(staff, 'restoreitem', ['Bob', 'gold_001', '0', 'x'])), /count must be/);
  await store.close();
});
