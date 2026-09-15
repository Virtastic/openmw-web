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
//
// ONE REGISTRY PER DEPLOYMENT (backlog 315). The player doc crosses worlds while the ids used
// to be minted per world, from 1 in each: a friend's potion carried home resolved to another
// world's record or fell out of the doc. The file now lives on the SHARED dir and every world
// process opens it at once, so the id is minted INSIDE an immediate transaction from the
// counter row (never from this process's memory), and reads pull rows other processes appended
// (seq past the last one seen) before answering.

import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { checkpoint, openDb } from './sqlite';
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
  private lastSeq = 0;
  private loaded: Promise<void>;
  private write: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.db = openDb(join(dataDir, 'world', 'records.db'), MIGRATIONS);
    this.loaded = this.load();
  }

  private async load(): Promise<void> {
    this.sync();
  }

  // Pull rows appended since the last read -- by this process or by a sibling world on the
  // same shared dir. Cheap (an indexed range on seq), and every read path runs it.
  private sync(): void {
    const rows = this.db
      .prepare('SELECT seq, recordNetId, kind, data, byAccount FROM records WHERE seq > ? ORDER BY seq')
      .all(this.lastSeq) as
      { seq: number; recordNetId: string; kind: string; data: string; byAccount: string | null }[];
    for (const r of rows) {
      this.lastSeq = r.seq;
      if (this.byId.has(r.recordNetId)) continue;
      const rec: CustomRecord = {
        recordNetId: r.recordNetId,
        kind: r.kind as RecordKind,
        data: JSON.parse(r.data) as JsLike,
        ...(r.byAccount ? { byAccount: r.byAccount } : {}),
      };
      this.records.push(rec);
      this.byId.set(rec.recordNetId, rec);
    }
  }

  ready(): Promise<void> {
    return this.loaded;
  }

  count(): number {
    this.sync();
    return this.records.length;
  }

  all(): CustomRecord[] {
    this.sync();
    return this.records;
  }

  get(recordNetId: string): CustomRecord | undefined {
    if (!this.byId.has(recordNetId)) this.sync();
    return this.byId.get(recordNetId);
  }

  // Mints the id, appends, and resolves only once the row is durably committed.
  async create(kind: RecordKind, data: JsLike, byAccount?: string): Promise<CustomRecord> {
    let record!: CustomRecord;
    // The counter read, the row and the bumped counter go in ONE IMMEDIATE transaction: a
    // crash between them would either reissue an id or skip one, and the id is the thing
    // clients hold onto; a sibling process minting at the same moment waits on the write lock
    // (busy_timeout) and then reads the counter this one bumped.
    this.queue(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const meta = this.db.prepare("SELECT v FROM records_meta WHERE k = 'nextId'").get() as
          { v: number } | undefined;
        const id = meta?.v ?? 1;
        record = { recordNetId: `mp_${kind}_${id}`, kind, data, ...(byAccount ? { byAccount } : {}) };
        this.db
          .prepare('INSERT INTO records (recordNetId, kind, data, byAccount) VALUES (?, ?, ?, ?)')
          .run(record.recordNetId, record.kind, JSON.stringify(record.data), record.byAccount ?? null);
        this.db
          .prepare("INSERT INTO records_meta (k, v) VALUES ('nextId', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
          .run(id + 1);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    });
    await this.write;
    if (record === undefined) throw new Error('records: create did not commit');
    this.sync(); // picks up our own row (and any sibling's) in seq order
    return record;
  }

  private queue(fn: () => void): void {
    this.write = this.write.then(() =>
      timeFlush('records', async () => fn()).catch((err) =>
        log('error', 'records.flush_failed', { error: String(err) }),
      ),
    );
  }

  async flush(): Promise<void> {
    await this.write;
    checkpoint(this.db);
  }

  close(): Promise<void> {
    return this.write;
  }
}
