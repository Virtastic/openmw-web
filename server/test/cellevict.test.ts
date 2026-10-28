// OT3-102: a clean cell can leave the cache and reloads from disk; a dirty one never evicts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CellStore } from '../src/persist/cellstore';
import { tmpDataDir } from './helpers';

test('evictClean keeps dirty cells, drops flushed ones, and the row reloads', async () => {
  const cs = new CellStore(tmpDataDir());
  await cs.ready();
  const doc = await cs.get('balmora');
  doc.doors['d:1'] = true;
  cs.markDirty('balmora');
  assert.equal(cs.evictClean('balmora'), false);
  assert.ok(cs.getCached('balmora'));
  await cs.flushKey('balmora');
  assert.equal(cs.evictClean('balmora'), true);
  assert.equal(cs.getCached('balmora'), undefined);
  assert.equal((await cs.get('balmora')).doors['d:1'], true);
  await cs.close();
});
