// OT3-94: bursts of cell-change / journal-step writes coalesce; nothing is lost on release.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerStore } from '../src/persist/playerstore';
import { readPlayerDoc, tmpDataDir } from './helpers';

test('debounced updates write nothing until release, then land whole', async () => {
  const dir = tmpDataDir();
  const store = new PlayerStore(dir);
  for (let i = 0; i < 50; i++) store.update('c1', (doc) => { doc.position = { cellKey: `cell${i}`, x: i, y: 0, z: 0 }; }, 'debounced');
  assert.equal(readPlayerDoc(dir, 'c1'), undefined, 'a burst of 50 cell changes wrote nothing yet');
  await store.releaseCached('c1'); // disconnect path
  assert.equal((readPlayerDoc(dir, 'c1') as { position: { cellKey: string } }).position.cellKey, 'cell49');
  await store.close();
});
