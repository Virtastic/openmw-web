// OT3-190: scheduled broadcasts and MOTD changes. Rows live in schedule.db so a restart
// before the time does not lose them; a row whose time passed while the server was down
// fires on the first tick after start (late, never dropped). Staff drive it through
// /schedule (admin.ts), which the command audit already records.

import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { openDb } from '../persist/sqlite';
import { log } from '../log';

export type ScheduledKind = 'say' | 'motd';
export interface ScheduledRow { id: number; at: number; kind: ScheduledKind; text: string; by: string }

export const SCHEDULE_TICK_MS = 5_000;

export class Schedule {
  private readonly db: DatabaseSync;
  private timer?: NodeJS.Timeout;

  constructor(dir: string, private readonly fire: (kind: ScheduledKind, text: string) => void) {
    this.db = openDb(join(dir, 'schedule.db'), [{
      name: '001-schedule',
      up: (db: DatabaseSync) => db.exec(`CREATE TABLE schedule (
        id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, by TEXT NOT NULL)`),
    }]);
  }

  start(): void {
    this.timer ??= setInterval(() => this.tick(), SCHEDULE_TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  add(at: number, kind: ScheduledKind, text: string, by: string): number {
    return Number(this.db.prepare('INSERT INTO schedule (at, kind, text, by) VALUES (?, ?, ?, ?)')
      .run(at, kind, text, by).lastInsertRowid);
  }

  cancel(id: number): boolean {
    return this.db.prepare('DELETE FROM schedule WHERE id = ?').run(id).changes > 0;
  }

  list(): ScheduledRow[] {
    return this.db.prepare('SELECT id, at, kind, text, by FROM schedule ORDER BY at').all() as unknown as ScheduledRow[];
  }

  /** Fire everything due. Deleted first, so a throwing fire() can never repeat forever. */
  tick(now = Date.now()): void {
    const due = this.db.prepare('SELECT id, at, kind, text, by FROM schedule WHERE at <= ? ORDER BY at')
      .all(now) as unknown as ScheduledRow[];
    for (const r of due) {
      this.db.prepare('DELETE FROM schedule WHERE id = ?').run(r.id);
      try {
        this.fire(r.kind, r.text);
        log('info', 'schedule.fired', { id: r.id, kind: r.kind, by: r.by, lateMs: now - r.at });
      } catch (err) {
        log('error', 'schedule.fire_failed', { id: r.id, error: String(err) });
      }
    }
  }
}
