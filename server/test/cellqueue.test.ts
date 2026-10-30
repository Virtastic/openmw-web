// OT3-98: per-cell op lanes + a global lane; a throwing op is logged and leaves its cell unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CellQueue } from '../src/world/cellqueue';
import { CellStore } from '../src/persist/cellstore';
import { tmpDataDir } from './helpers';

const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

function mk() {
  const errors: [unknown, string | undefined][] = [];
  return { q: new CellQueue({ onError: (e, c) => errors.push([e, c]) }), errors };
}

test('a stalled cell does not stall another cell', async () => {
  const { q } = mk();
  const g = gate();
  const order: string[] = [];
  const a = q.run('a', async () => { await g.p; order.push('a'); });
  await q.run('b', () => { order.push('b'); });
  assert.deepEqual(order, ['b']);
  g.open();
  await a;
  assert.deepEqual(order, ['b', 'a']);
});

test('ops on one cell stay in order', async () => {
  const { q } = mk();
  const order: number[] = [];
  const g = gate();
  void q.run('a', async () => { await g.p; order.push(1); });
  void q.run('a', () => { order.push(2); });
  const last = q.run('a', async () => { await Promise.resolve(); order.push(3); });
  g.open();
  await last;
  assert.deepEqual(order, [1, 2, 3]);
});

test('a global op waits for earlier cell ops and holds back later ones', async () => {
  const { q } = mk();
  const order: string[] = [];
  const g = gate();
  void q.run('a', async () => { await g.p; order.push('a1'); });
  void q.run('b', () => { order.push('b1'); });
  const glob = q.runGlobal(() => { order.push('G'); });
  const after = q.run('c', () => { order.push('c1'); });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(order, ['b1']);
  g.open();
  await Promise.all([glob, after]);
  assert.deepEqual(order, ['b1', 'a1', 'G', 'c1']);
  await q.drain();
  assert.equal(q.busyCells, 0);
});

test('a throwing op is reported with its cell and the lane carries on', async () => {
  const { q, errors } = mk();
  const seen: string[] = [];
  void q.run('a', () => { throw new Error('boom'); });
  await q.run('a', () => { seen.push('next'); });
  await q.runGlobal(() => { throw new Error('g'); });
  assert.deepEqual(seen, ['next']);
  assert.equal(errors.length, 2);
  assert.equal(errors[0]![1], 'a');
  assert.equal(errors[1]![1], undefined);
});

test('a throwing op leaves its cell as it found it (loaded+dirty and cold cases)', async () => {
  const cs = new CellStore(tmpDataDir());
  await cs.ready();
  const errors: unknown[] = [];
  const q = new CellQueue({
    onError: (e) => errors.push(e),
    snapshot: (k) => cs.snapshotCell(k),
    restore: (k, s) => cs.restoreCell(k, s as ReturnType<CellStore['snapshotCell']>),
  });
  const doc = await cs.get('x');
  doc.doors['d:1'] = true;
  cs.markDirty('x');
  await q.run('x', async () => { (await cs.get('x')).doors['d:2'] = true; throw new Error('mid'); });
  const after = await cs.get('x');
  assert.equal(after.doors['d:1'], true);
  assert.equal(after.doors['d:2'], undefined);
  assert.equal(cs.evictClean('x'), false); // still dirty
  await q.run('y', async () => { (await cs.get('y')).doors['d:9'] = true; cs.markDirty('y'); throw new Error('cold'); });
  assert.equal(cs.getCached('y'), undefined);
  assert.equal((await cs.get('y')).doors['d:9'], undefined);
  assert.equal(errors.length, 2);
  await cs.close();
});

test('concurrent ops across two cells and on one cell: no lost update', async () => {
  const { q } = mk();
  const n = { a: 0, b: 0 };
  const tasks: Promise<void>[] = [];
  for (let i = 0; i < 200; i++) {
    for (const k of ['a', 'b'] as const) {
      tasks.push(q.run(k, async () => { const v = n[k]; await new Promise((r) => setImmediate(r)); n[k] = v + 1; }));
    }
  }
  await Promise.all(tasks);
  assert.deepEqual(n, { a: 200, b: 200 });
});
