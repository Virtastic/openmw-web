// OT3-89: kill tallies live in their own table; a kill never touches world_global.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CellStore } from '../src/persist/cellstore';
import { tmpDataDir } from './helpers';

test('kill tally: no world_global write, survives restart, legacy doc.kills migrated', async () => {
  const dir = tmpDataDir();
  const dbPath = join(dir, 'world', 'world.db');
  let cs = new CellStore(dir);
  await cs.ready();
  cs.allocNetId(); // forces the first world_global row
  await cs.flushAll();
  const raw = new DatabaseSync(dbPath);
  const before = (raw.prepare('SELECT doc FROM world_global').get() as { doc: string }).doc;
  cs.bumpKill('rat'); cs.bumpKill('rat'); cs.bumpKill('scrib');
  await cs.flushAll();
  assert.equal((raw.prepare('SELECT doc FROM world_global').get() as { doc: string }).doc, before);
  await cs.close();

  cs = new CellStore(dir);
  await cs.ready();
  assert.equal(cs.killCount('rat'), 2);
  assert.equal(cs.killCount('scrib'), 1);
  await cs.close();

  // A pre-OT3-89 db: tallies only inside the world_global doc, no kill table yet.
  raw.exec("DROP TABLE kill; DELETE FROM schema_migrations WHERE name = '002-kill-table'");
  raw.prepare('UPDATE world_global SET doc = ?').run(JSON.stringify({ nextNetIdCeiling: 500, kills: { ash_ghoul: 7 } }));
  raw.close();
  cs = new CellStore(dir);
  await cs.ready();
  assert.equal(cs.killCount('ash_ghoul'), 7);
  await cs.close();
});
