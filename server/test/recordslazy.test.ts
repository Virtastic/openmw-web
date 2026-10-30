// OT3-81: dedupe is a hash lookup, every account has a share of the store, and the ref scanner that
// drives lazy delivery finds ids in values, keys and nested bodies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { RecordStore } from '../src/persist/recordstore';
import { recordRefsIn } from '../src/core/m7';
import { TestClient, tmpDataDir } from './helpers';

test('record store: content index, per-account counts, ref scanning', async () => {
  const store = new RecordStore(tmpDataDir());
  await store.ready();
  const a = await store.create('potion', { name: 'brew' } as never, 'ann');
  await store.create('spell', { name: 'bolt' } as never, 'ann');
  await store.create('potion', { name: 'other' } as never, 'bob');
  assert.equal(store.findByContent('potion', JSON.stringify({ name: 'brew' }))?.recordNetId, a.recordNetId);
  assert.equal(store.findByContent('spell', JSON.stringify({ name: 'brew' })), undefined, 'kind is part of the key');
  assert.equal(store.countBy('ann'), 2);
  assert.equal(store.countBy('bob'), 1);
  assert.equal(store.countBy('nobody'), 0);
  assert.deepEqual(store.authoredBy('bob').map((r) => r.recordNetId), ['mp_potion_3']);
  assert.deepEqual(recordRefsIn({ inv: { mp_potion_3: 2 }, eq: [{ id: 'mp_spell_2' }], text: 'plain', n: 4 }).sort(),
    ['mp_potion_3', 'mp_spell_2']);
  assert.deepEqual(recordRefsIn({ a: 'mp_nothing_9', b: 'xmp_' }), []);
  await store.close();
});

test('a player past the per-account record quota is refused, others are not', async (t) => {
  const dataDir = tmpDataDir();
  const fill = new RecordStore(dataDir);
  await fill.ready();
  for (let i = 0; i < 1000; i++) await fill.create('potion', { n: i } as never, 'greedy');
  await fill.close();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: { time: { scale: 0 }, limits: { maxConnsPerIp: 16, loginPerMinPerIp: 60 } } });
  t.after(() => server.close());
  const c = await TestClient.connect(server.port);
  await c.joinAsNew('Greedy');
  c.sendEvent('RecordCreate', { tempId: 5, kind: 'potion', data: { name: 'one more' } });
  assert.deepEqual((await c.waitEvent('RecordCreateRefused')).value, { tempId: 5, reason: 'record quota reached' });
  c.sendEvent('RecordCreate', { tempId: 6, kind: 'potion', data: { n: 7 } }); // identical to one it already has
  assert.equal(((await c.waitEvent('RecordCreateAck')).value as { tempId: number }).tempId, 6);
  const d = await TestClient.connect(server.port);
  await d.joinAsNew('Modest');
  d.sendEvent('RecordCreate', { tempId: 1, kind: 'potion', data: { name: 'fine' } });
  assert.equal(((await d.waitEvent('RecordCreateAck')).value as { tempId: number }).tempId, 1);
  c.close(); d.close();
  await c.closed; await d.closed;
});
