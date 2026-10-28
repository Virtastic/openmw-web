// OT3-187: a timed ban lifts itself on the next read; a ban needs a reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BanStore } from '../src/persist/banstore';
import { banTerms } from '../src/core/admin';
import { tmpDataDir } from './helpers';

test('banTerms: optional span, mandatory reason', () => {
  const now = 1_000_000;
  assert.deepEqual(banTerms(['X', '1h', 'spam'], now), { reason: 'spam', until: now + 3_600_000 });
  assert.deepEqual(banTerms(['X', '1d spamming links'], now), { reason: 'spamming links', until: now + 86_400_000 }, 'dashboard: one field');
  assert.deepEqual(banTerms(['X', 'perm', 'cheating'], now), { reason: 'cheating' });
  assert.deepEqual(banTerms(['X', 'cheating'], now), { reason: 'cheating' });
  assert.equal(banTerms(['X'], now), undefined);
  assert.equal(banTerms(['X', '30m'], now), undefined);
  assert.equal(banTerms(['X', '999d', 'too long'], now), undefined);
});

test('an expired ban lifts itself, in every process sharing bans.db', async () => {
  const dir = tmpDataDir();
  const a = new BanStore(dir);
  a.banAccount('Griefer', 'Mod', 'spam', Date.now() + 60_000);
  a.banAccount('Temp', 'Mod', 'spam', Date.now() - 1);
  a.banIp('10.0.0.9', 'Mod', 'proxy', Date.now() - 1);
  await a.flush();
  const b = new BanStore(dir); // another world process
  assert.equal(b.isAccountBanned('griefer')?.reason, 'spam');
  assert.ok(b.isAccountBanned('griefer')?.until);
  assert.deepEqual(b.listAccounts(), ['griefer']);
  assert.equal(b.isAccountBanned('Temp'), undefined);
  assert.equal(b.isIpBanned('10.0.0.9'), undefined);
  await b.flush();
  const c = new BanStore(dir);
  assert.deepEqual([c.listAccounts(), c.listIps()], [['griefer'], []], 'the expired rows are gone from disk');
  await Promise.all([a.close(), b.close(), c.close()]);
});
