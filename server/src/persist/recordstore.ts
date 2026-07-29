// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M7 custom-record store: <dataDir>/world/records.db (SQLite). Player-made records (enchanted
// items, custom spells/potions) get a SERVER-issued recordNetId here — M3 showed that
// client-local dynamic record ids collide across clients, so a peer resolving a raw
// local id could land on an unrelated record. The id is minted once, persisted, and
// replayed to every joiner via RecordsSync, so every client resolves the same string.
//
// The ack path AWAITS durability: a client that holds an ack for a record the server forgot
// after a crash would carry a dangling id forever. node:sqlite writes synchronously and the
// WAL commit is durable when the statement returns, so create() is safe once run() returns.
//
// Insertion order IS the RecordsSync order, so rows carry an explicit autoincrement `seq`
// rather than relying on rowid ordering by accident.

import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, tx } from './sqlite';
import type { JsLike } from '../proto/lser';
import { log } from '../log';
import { timeFlush } from '../metrics';

export type RecordKind =
  | 'spell' | 'potion' | 'enchantment' | 'armor' | 'weapon' | 'clothing' | 'book' | 'misc';

export const RECORD_KINDS: ReadonlySet<string> = new Set<RecordKind>([
  'spell', 'potion', 'enchantment', 'armor', 'weapon', 'clothing', 'book', 'misc',
]);

export interface CustomRecord {
  recordNetId: string;
  kind: RecordKind;
  data: JsLike;
  byAccount?: string; // informational: who authored it
}

const MIGRATIONS = [
  {
    name: '001-records',
    up: (db: DatabaseSync) => {
      db.exec(`CREATE TABLE records (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        recordNetId TEXT NOT NULL UNIQUE,
        kind       TEXT NOT NULL,
        data       TEXT NOT NULL,   -- JSON: the record body is free-form client data
        byAccount  TEXT
      )`);
      // nextId is a counter, not derivable from the rows: ids are never reused even after a
      // record is removed, so it is stored rather than computed as MAX(seq)+1.
      db.exec(`CREATE TABLE records_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`);
    },
  },
];

export class RecordStore {
  private readonly db: DatabaseSync;
  private records: CustomRecord[] = [];
  private byId = new Map<string, CustomRecord>();
  private nextId = 1;
  private loaded: Promise<void>;
  private write: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.db = openDb(join(dataDir, 'world', 'records.db'), MIGRATIONS);
    this.loaded = this.load();
  }

  private async load(): Promise<void> {
    const rows = this.db
      .prepare('SELECT recordNetId, kind, data, byAccount FROM records ORDER BY seq')
      .all() as { recordNetId: string; kind: string; data: string; byAccount: string | null }[];
    for (const r of rows) {
      const rec: CustomRecord = {
        recordNetId: r.recordNetId,
        kind: r.kind as RecordKind,
        data: JSON.parse(r.data) as JsLike,
        ...(r.byAccount ? { byAccount: r.byAccount } : {}),
      };
      this.records.push(rec);
      this.byId.set(rec.recordNetId, rec);
    }
    const meta = this.db.prepare("SELECT v FROM records_meta WHERE k = 'nextId'").get() as
      { v: number } | undefined;
    if (meta) this.nextId = meta.v;

  }

  ready(): Promise<void> {
    return this.loaded;
  }

  count(): number {
    return this.records.length;
  }

  all(): CustomRecord[] {
    return this.records;
  }

  get(recordNetId: string): CustomRecord | undefined {
    return this.byId.get(recordNetId);
  }

  // Mints the id, appends, and resolves only once the row is durably committed.
  async create(kind: RecordKind, data: JsLike, byAccount?: string): Promise<CustomRecord> {
    const record: CustomRecord = {
      recordNetId: `mp_${kind}_${this.nextId++}`,
      kind,
      data,
      ...(byAccount ? { byAccount } : {}),
    };
    this.records.push(record);
    this.byId.set(record.recordNetId, record);
    // The row and the bumped counter go in ONE transaction: a crash between them would either
    // reissue an id or skip one, and the id is the thing clients hold onto.
    this.queue(() =>
      tx(this.db, () => {
        this.db
          .prepare('INSERT INTO records (recordNetId, kind, data, byAccount) VALUES (?, ?, ?, ?)')
          .run(record.recordNetId, record.kind, JSON.stringify(record.data), record.byAccount ?? null);
        this.putNextId();
      }),
    );
    await this.write;
    return record;
  }

  private putNextId(): void {
    this.db
      .prepare("INSERT INTO records_meta (k, v) VALUES ('nextId', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .run(this.nextId);
  }

  private persistAll(): void {
    this.queue(() =>
      tx(this.db, () => {
        const stmt = this.db.prepare(
          'INSERT OR REPLACE INTO records (recordNetId, kind, data, byAccount) VALUES (?, ?, ?, ?)',
        );
        for (const r of this.records) {
          stmt.run(r.recordNetId, r.kind, JSON.stringify(r.data), r.byAccount ?? null);
        }
        this.putNextId();
      }),
    );
  }

  private queue(fn: () => void): void {
    this.write = this.write.then(() =>
      timeFlush('records', async () => fn()).catch((err) =>
        log('error', 'records.flush_failed', { error: String(err) }),
      ),
    );
  }

  flush(): Promise<void> {
    return this.write;
  }

  close(): Promise<void> {
    return this.write;
  }
}
