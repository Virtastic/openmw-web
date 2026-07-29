// Child process for the multi-process WAL test: opens the SAME db as its sibling and writes.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
const [dir, tag, n] = process.argv.slice(2);
const db = new DatabaseSync(join(dir, 'concurrent.db'));
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY)');
let wrote = 0;
for (let i = 0; i < Number(n); i++) {
  db.prepare('INSERT OR REPLACE INTO kv (k) VALUES (?)').run(`${tag}-${i}`);
  wrote++;
}
db.close();
console.log(`wrote=${wrote}`);
