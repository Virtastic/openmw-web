// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// A4 moderation: a durable chat log and a player-report inbox.
//
// Chat already goes to stdout via log(), but stdout is the operator's stream: it is level
// filtered, interleaved with connection noise, and rotated by whatever supervises the
// process. An abuse report is worthless without the surrounding lines, so chat gets its own
// append-only stream under <dataDir>/logs/chat-YYYY-MM-DD.jsonl — one JSON object per line,
// rotated by UTC day, pruned to [moderation] retentionDays (default 14, matching the
// documented backup retention in README.md).
//
// Writes are appended through a single promise chain so lines can never interleave
// mid-record, and a failing append is LOGGED, never swallowed — a silently dead chat log is
// worse than no chat log, because an operator would believe they had evidence.

import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, tx } from '../persist/sqlite';
import { log } from '../log';

const MIGRATIONS = [
  {
    name: '001-moderation',
    up: (db: DatabaseSync) => {
      // tsMs alongside the ISO ts: every read is a time RANGE (last N minutes, older than
      // retention), and an integer compare is the thing an index can actually use.
      db.exec(`CREATE TABLE chat_lines (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        tsMs     INTEGER NOT NULL,
        ts       TEXT NOT NULL,
        playerId INTEGER NOT NULL,
        account  TEXT NOT NULL,
        name     TEXT NOT NULL,
        channel  TEXT NOT NULL,
        text     TEXT NOT NULL
      )`);
      db.exec('CREATE INDEX chat_lines_ts ON chat_lines (tsMs)');
      // Erasure and /chatlog both filter by person; without this they scan the whole log.
      db.exec('CREATE INDEX chat_lines_account ON chat_lines (account)');
      db.exec(`CREATE TABLE reports (
        file   TEXT PRIMARY KEY,   -- stable id, kept in the old filename shape
        tsMs   INTEGER NOT NULL,
        doc    TEXT NOT NULL       -- the ReportDoc as JSON
      )`);
      db.exec('CREATE INDEX reports_ts ON reports (tsMs)');
    },
  },
];

export interface ChatLine {
  ts: string; // ISO 8601, UTC
  playerId: number;
  account: string; // lower-cased account key
  name: string; // display casing at the time the line was sent
  channel: string; // 'say' | 'server' | 'whisper' | 'command'
  text: string;
}

export interface ReportDoc {
  ts: string;
  reporter: { id: number; name: string; account: string };
  target: { id: number | null; name: string; account: string | null; cellKey: string | null };
  reason: string;
  context: ChatLine[]; // the lines immediately before the report was filed
}

export interface ModerationConfig {
  chatLog: boolean;
  retentionDays: number;
  contextLines: number;
}

export const MAX_REASON_CHARS = 512;
const MAX_CONTEXT_SCAN_DAYS = 31; // bounds /chatlog work no matter what minutes it is given
const DAY_MS = 86_400_000;

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Anything a player can name ends up in a filename here: keep it to a set that cannot
// escape the directory or collide with the rotation glob.
function safeName(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48);
  return cleaned.length > 0 ? cleaned : 'unknown';
}

// One line -> one JSON object. Parsing is per-line and tolerant: a torn last line (power
// loss mid-append) must not cost the operator the whole day's log.
function parseLines(raw: string): ChatLine[] {
  const out: ChatLine[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    try {
      const doc = JSON.parse(line) as ChatLine;
      if (typeof doc.ts === 'string' && typeof doc.text === 'string') out.push(doc);
    } catch {
      // A torn line is expected at most once, at the tail; count it rather than throwing.
      log('warn', 'chatlog.bad_line', { chars: line.length });
    }
  }
  return out;
}

export class ChatLog {
  private readonly db: DatabaseSync;
  private readonly ring: ChatLine[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly cfg: ModerationConfig,
  ) {
    this.db = openDb(join(dataDir, 'moderation.db'), MIGRATIONS);
    // Prune at boot, not on a timer: a server that is restarted regularly (every deploy)
    // would otherwise only ever prune on the rare long-lived process.
    if (cfg.chatLog) {
      this.enqueue(() => this.prune());
    }
  }

  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn).catch((err) => {
      log('error', 'chatlog.write_failed', { error: String(err) });
    });
  }

  private insert(line: ChatLine): void {
    this.db
      .prepare(`INSERT INTO chat_lines (tsMs, ts, playerId, account, name, channel, text)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(Date.parse(line.ts), line.ts, line.playerId, line.account, line.name, line.channel, line.text);
  }

  // Synchronous by design: the in-memory context ring must contain the line BEFORE the
  // /report that follows it in the same tick can read the ring.
  record(line: ChatLine): void {
    this.ring.push(line);
    if (this.ring.length > this.cfg.contextLines) this.ring.shift();
    if (!this.cfg.chatLog) return;
    this.enqueue(async () => this.insert(line));
  }

  // Last N lines seen by THIS process. Used for report context: it is the cheapest correct
  // answer and it cannot race a pending write.
  context(): ChatLine[] {
    return [...this.ring];
  }

  // Lets a caller (tests, /chatlog) observe everything recorded so far.
  drain(): Promise<void> {
    return this.queue;
  }

  // Reads back the last `minutes` of chat, optionally for one player. Backed by the table
  // rather than the ring so it still answers after a restart.
  async readRecent(minutes: number, nameFilter?: string): Promise<ChatLine[]> {
    await this.drain();
    // The scan is still bounded the way the day-file version was: a caller asking for a
    // year of chat must not be able to pull the whole table into memory.
    const cutoff = Math.max(
      Date.now() - minutes * 60_000,
      Date.now() - MAX_CONTEXT_SCAN_DAYS * DAY_MS,
    );
    const want = nameFilter?.toLowerCase();
    const rows = (
      want === undefined
        ? this.db
            .prepare(`SELECT ts, playerId, account, name, channel, text FROM chat_lines
                      WHERE tsMs >= ? ORDER BY id`)
            .all(cutoff)
        : this.db
            .prepare(`SELECT ts, playerId, account, name, channel, text FROM chat_lines
                      WHERE tsMs >= ? AND (LOWER(name) = ? OR account = ?) ORDER BY id`)
            .all(cutoff, want, want)
    ) as unknown as ChatLine[];
    return rows;
  }

  async prune(): Promise<void> {
    // Retention is counted in whole UTC DAYS, not exact milliseconds — that is the documented
    // policy (it matches the backup retention in README.md) and it is what the day-file
    // version enforced by comparing date strings. Flooring to the UTC midnight of the oldest
    // kept day preserves it: a line from exactly retentionDays ago survives its whole day
    // instead of being cut at the wall-clock instant the prune happens to run.
    const cutoff = Date.parse(dayKey(Date.now() - this.cfg.retentionDays * DAY_MS));
    const r = this.db.prepare('DELETE FROM chat_lines WHERE tsMs < ?').run(cutoff);
    if (Number(r.changes) > 0) log('info', 'chatlog.pruned', { lines: Number(r.changes) });
  }
}

export class ReportStore {
  private readonly db: DatabaseSync;

  constructor(
    dataDir: string,
    private readonly retentionDays: number,
  ) {
    this.db = openDb(join(dataDir, 'moderation.db'), MIGRATIONS);
  }

  // Returns the report's id. Kept in the old filename shape so existing callers, admin output
  // and tests still have a stable, human-readable handle for one report.
  async write(doc: ReportDoc): Promise<string> {
    const file = `${doc.ts.replace(/[:.]/g, '-')}-${safeName(doc.reporter.name)}.json`;
    this.db
      .prepare('INSERT OR REPLACE INTO reports (file, tsMs, doc) VALUES (?, ?, ?)')
      .run(file, Date.parse(doc.ts), JSON.stringify(doc));
    return file;
  }

  // Newest first. A single unreadable report must not hide every other one, so a bad row is
  // logged and skipped rather than failing the whole listing.
  async list(limit = 20): Promise<{ file: string; doc: ReportDoc }[]> {
    const capped = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : -1;
    const rows = this.db
      .prepare('SELECT file, doc FROM reports ORDER BY file DESC LIMIT ?')
      .all(capped === -1 ? -1 : capped) as { file: string; doc: string }[];
    const out: { file: string; doc: ReportDoc }[] = [];
    for (const r of rows) {
      try {
        out.push({ file: r.file, doc: JSON.parse(r.doc) as ReportDoc });
      } catch (err) {
        log('warn', 'reports.unreadable', { file: r.file, error: String(err) });
      }
    }
    return out;
  }

  async prune(): Promise<void> {
    const cutoff = Date.now() - this.retentionDays * DAY_MS;
    const r = this.db.prepare('DELETE FROM reports WHERE tsMs < ?').run(cutoff);
    if (Number(r.changes) > 0) log('info', 'reports.pruned', { reports: Number(r.changes) });
  }
}

export class Moderation {
  readonly chat: ChatLog;
  readonly reports: ReportStore;
  // Phase 3.6: per-account anomaly tallies (implausible movement, capped hits, refused
  // content). In memory by design — this is a LIVE signal a moderator reads next to the
  // report queue ("this account tripped the speed envelope 400 times this session"), not
  // evidence to keep forever about someone who may simply have had a bad connection.
  private readonly anomalies = new Map<string, Map<string, number>>();

  noteAnomaly(accountKey: string, kind: string): void {
    const forAccount = this.anomalies.get(accountKey) ?? new Map<string, number>();
    forAccount.set(kind, (forAccount.get(kind) ?? 0) + 1);
    this.anomalies.set(accountKey, forAccount);
  }

  anomaliesFor(accountKey: string): Record<string, number> {
    return Object.fromEntries(this.anomalies.get(accountKey) ?? []);
  }

  allAnomalies(): Record<string, Record<string, number>> {
    return Object.fromEntries([...this.anomalies].map(([k, v]) => [k, Object.fromEntries(v)]));
  }

  forgetAnomalies(accountKey: string): void {
    this.anomalies.delete(accountKey);
  }

  constructor(dataDir: string, cfg: ModerationConfig) {
    this.chat = new ChatLog(dataDir, cfg);
    this.reports = new ReportStore(dataDir, cfg.retentionDays);
    // Same rationale as the chat prune: boot is the reliable moment.
    void this.reports.prune().catch((err) => log('error', 'reports.prune_failed', { error: String(err) }));
  }

  // Called on the close path so a shutdown cannot truncate the evidence trail.
  flush(): Promise<void> {
    return this.chat.drain();
  }
}
