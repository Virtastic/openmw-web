// OT3-194: /rename forces a new character name, enforces the chargen rules and uniqueness,
// and keeps the old name in the audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore } from '../src/core/accounts';
import { AdminAudit } from '../src/core/admin-audit';
import { Admin } from '../src/core/admin';
import type { Player } from '../src/core/players';
import { tmpDataDir } from './helpers';

test('/rename works offline, enforces name rules, and audits the old name', async () => {
  const dir = tmpDataDir();
  const store = new AccountStore(dir);
  const a = await store.createSso('victim');
  const b = await store.createSso('other');
  assert.ok(typeof a !== 'string' && typeof b !== 'string');
  const ca = store.createCharacter(a, 'Rude Name');
  const cb = store.createCharacter(b, 'Taken Name');
  assert.ok(typeof ca !== 'string' && typeof cb !== 'string');
  const audit = new AdminAudit(dir);
  const admin = new Admin({
    audit, allow: () => true, motd: () => '', setMotd: () => {},
    roster: { findByName: () => undefined }, resume: { revokeAccount: () => {} },
    chars: {
      resolve: async () => ca.id, edit: () => {}, safePoint: () => ({ cellKey: 'x', x: 0, y: 0, z: 0 }),
      rename: (k: string, n: string) => store.renameCharacter(k, n),
    },
  } as never);
  const staff = { id: 1, name: 'Admin', accountKey: 'staff', rank: 1 } as Player;

  assert.match(String(await admin.exec(staff, 'rename', ['victim', 'Taken', 'Name', '--', 'x'])), /already has that name/);
  assert.match(String(await admin.exec(staff, 'rename', ['victim', 'B4d', '--', 'x'])), /letters only/);
  assert.match(String(await admin.exec(staff, 'rename', ['victim', 'Nice', 'Name'])), /usage/);
  assert.match(String(await admin.exec(staff, 'rename', ['victim', 'Nice', 'Name', '--', 'offensive'])), /Renamed Rude Name to Nice Name/);
  const fresh = await new AccountStore(dir).get('victim');
  assert.equal(fresh?.characters?.find((c) => c.id === ca.id)?.name, 'Nice Name');
  assert.ok(audit.recent().some((r) => r.cmd === 'rename' && /Rude Name/.test(r.result)));
  assert.match(String(await store.renameCharacter('nope', 'Fine Name')), /No character/);
});
