// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M7 custom-record store: <dataDir>/world/records.json. Player-made records (enchanted
// items, custom spells/potions) get a SERVER-issued recordNetId here — M3 showed that
// client-local dynamic record ids collide across clients, so a peer resolving a raw
// local id could land on an unrelated record. The id is minted once, persisted, and
// replayed to every joiner via RecordsSync, so every client resolves the same string.
//
// Writes are serialized and atomic like the cell/global stores, but the ack path AWAITS
// durability: a client that holds an ack for a record the server forgot after a crash
// would carry a dangling id forever.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './atomicjson';
import type { JsLike } from '../proto/lser';
import { log } from '../log';

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

interface RecordsDoc {
  nextId: number;
  records: CustomRecord[]; // insertion order == creation order == RecordsSync order
}

export class RecordStore {
  private readonly path: string;
  private records: CustomRecord[] = [];
  private byId = new Map<string, CustomRecord>();
  private nextId = 1;
  private loaded: Promise<void>;
  private write: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    mkdirSync(join(dataDir, 'world'), { recursive: true });
    this.path = join(dataDir, 'world', 'records.json');
    this.loaded = readJson<RecordsDoc>(this.path).then((doc) => {
      if (!doc) return;
      if (Number.isInteger(doc.nextId) && doc.nextId > 0) this.nextId = doc.nextId;
      for (const r of doc.records ?? []) {
        this.records.push(r);
        this.byId.set(r.recordNetId, r);
      }
    });
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

  // Mints the id, appends, and resolves only once the file is on disk.
  async create(kind: RecordKind, data: JsLike, byAccount?: string): Promise<CustomRecord> {
    const record: CustomRecord = {
      recordNetId: `mp_${kind}_${this.nextId++}`,
      kind,
      data,
      ...(byAccount ? { byAccount } : {}),
    };
    this.records.push(record);
    this.byId.set(record.recordNetId, record);
    await this.flush();
    return record;
  }

  flush(): Promise<void> {
    this.write = this.write.then(() =>
      writeJsonAtomic(this.path, { nextId: this.nextId, records: this.records } satisfies RecordsDoc)
        .catch((err) => log('error', 'records.flush_failed', { error: String(err) })),
    );
    return this.write;
  }

  close(): Promise<void> {
    return this.write;
  }
}
