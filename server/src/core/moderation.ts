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

import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../log';

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
  private readonly dir: string;
  private readonly ring: ChatLine[] = [];
  private queue: Promise<void> = Promise.resolve();
  private lastDay = '';

  constructor(
    dataDir: string,
    private readonly cfg: ModerationConfig,
  ) {
    this.dir = join(dataDir, 'logs');
    // Prune at boot, not on a timer: a server that is restarted regularly (every deploy)
    // would otherwise only ever prune on the rare long-lived process.
    if (cfg.chatLog) this.enqueue(() => this.prune());
  }

  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn).catch((err) => {
      log('error', 'chatlog.write_failed', { error: String(err) });
    });
  }

  // Synchronous by design: the in-memory context ring must contain the line BEFORE the
  // /report that follows it in the same tick can read the ring.
  record(line: ChatLine): void {
    this.ring.push(line);
    if (this.ring.length > this.cfg.contextLines) this.ring.shift();
    if (!this.cfg.chatLog) return;
    const day = dayKey(Date.parse(line.ts));
    const rolled = this.lastDay !== '' && this.lastDay !== day;
    this.lastDay = day;
    this.enqueue(async () => {
      await mkdir(this.dir, { recursive: true });
      await appendFile(join(this.dir, `chat-${day}.jsonl`), JSON.stringify(line) + '\n', 'utf8');
    });
    if (rolled) this.enqueue(() => this.prune());
  }

  // Last N lines seen by THIS process. Used for report context: it is the cheapest correct
  // answer and it cannot race a pending append.
  context(): ChatLine[] {
    return [...this.ring];
  }

  // Lets a caller (tests, /chatlog) observe everything recorded so far on disk.
  drain(): Promise<void> {
    return this.queue;
  }

  // Reads back the last `minutes` of chat from the day files, optionally for one player.
  // Disk-backed rather than ring-backed so it still answers after a restart.
  async readRecent(minutes: number, nameFilter?: string): Promise<ChatLine[]> {
    await this.drain();
    const now = Date.now();
    const cutoff = now - minutes * 60_000;
    // Span the day files the window actually TOUCHES, not the number of whole days it is
    // long. Files are keyed by UTC date (dayKey uses toISOString), so a short window can
    // still straddle a UTC midnight: `floor(60min / 24h) + 1` says one file, while the
    // window really covers two. That made /chatlog return nothing from before midnight —
    // precisely when an admin is reviewing an incident that just happened. DAY_MS buckets
    // align to UTC epoch days, so flooring each end gives the real file span.
    const days = Math.min(
      MAX_CONTEXT_SCAN_DAYS,
      Math.floor(now / DAY_MS) - Math.floor(cutoff / DAY_MS) + 1,
    );
    const want = nameFilter?.toLowerCase();
    const out: ChatLine[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const path = join(this.dir, `chat-${dayKey(now - i * DAY_MS)}.jsonl`);
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // no chat that day
        throw err;
      }
      for (const line of parseLines(raw)) {
        if (Date.parse(line.ts) < cutoff) continue;
        if (want && line.name.toLowerCase() !== want && line.account !== want) continue;
        out.push(line);
      }
    }
    return out;
  }

  async prune(): Promise<void> {
    const oldest = dayKey(Date.now() - this.cfg.retentionDays * DAY_MS);
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // nothing logged yet
      throw err;
    }
    for (const name of names) {
      const m = /^chat-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      // Lexicographic compare is correct for ISO dates, and it never has to parse a
      // filename an operator may have dropped in the directory by hand.
      if (m && m[1]! < oldest) {
        await rm(join(this.dir, name), { force: true });
        log('info', 'chatlog.pruned', { file: name });
      }
    }
  }
}

export class ReportStore {
  private readonly dir: string;

  constructor(
    dataDir: string,
    private readonly retentionDays: number,
  ) {
    this.dir = join(dataDir, 'reports');
  }

  async write(doc: ReportDoc): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const file = `${doc.ts.replace(/[:.]/g, '-')}-${safeName(doc.reporter.name)}.json`;
    await writeFile(join(this.dir, file), JSON.stringify(doc, null, 2) + '\n', 'utf8');
    return file;
  }

  // Newest first. A single unreadable report must not hide every other one, so a bad file
  // is logged and skipped rather than failing the whole listing.
  async list(limit = 20): Promise<{ file: string; doc: ReportDoc }[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: { file: string; doc: ReportDoc }[] = [];
    for (const file of names.filter((n) => n.endsWith('.json')).sort().reverse().slice(0, limit)) {
      try {
        out.push({ file, doc: JSON.parse(await readFile(join(this.dir, file), 'utf8')) as ReportDoc });
      } catch (err) {
        log('warn', 'reports.unreadable', { file, error: String(err) });
      }
    }
    return out;
  }

  async prune(): Promise<void> {
    const cutoff = Date.now() - this.retentionDays * DAY_MS;
    for (const { file, doc } of await this.list(Number.MAX_SAFE_INTEGER)) {
      if (Date.parse(doc.ts) < cutoff) {
        await rm(join(this.dir, file), { force: true });
        log('info', 'reports.pruned', { file });
      }
    }
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
