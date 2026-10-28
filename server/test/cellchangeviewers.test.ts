// OT3-78: PlayerCellChange reaches viewers of the old/new cell, not the whole world.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

test('a cell change is relayed to viewers of the cell only', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { login: { allowHarnessAuth: true } },
  });
  t.after(() => server.close());
  const join = async (n: string, cell: string) => {
    const c = await TestClient.connect(server.port);
    t.after(() => c.close());
    await c.joinAsNew(n, 'hunter22');
    c.sendCellChange(cell, 10, 10, 0);
    return c;
  };
  const near = await join('Near', '0,0');
  const far = await join('Far', '9,9');
  const mover = await join('Mover', '5,5');
  await new Promise((r) => setTimeout(r, 300));
  near.inbox.events.length = 0;
  far.inbox.events.length = 0;
  mover.sendCellChange('0,1', 20, 20, 0);
  const got = await near.waitEvent('PlayerCellChange');
  assert.equal((got.value as { cellKey?: string }).cellKey, '0,1');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(far.inbox.events.filter((e) => e.name === 'PlayerCellChange').length, 0);
});
