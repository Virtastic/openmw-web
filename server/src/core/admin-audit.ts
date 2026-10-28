// OT3-183: the durable staff-action audit. One row per command through Admin.exec (the one
// gate every operator command passes), refusals included: who, what, on whom, with which
// args, why, and how it ended. The log ring stays for "what just happened"; this answers
// "who did this and why" after a restart.

import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { openDb } from '../persist/sqlite';

export interface AuditRow {
  ts: number;
  actor: string;       // account key
  actorName: string;
  cmd: string;
  target: string;      // first arg by convention (/kick <player> ...), '' when none
  args: string;        // every arg, space-joined, capped
  reason: string;      // the rest after the target
  outcome: 'ok' | 'refused' | 'vetoed' | 'failed';
  result: string;      // what the actor was told, capped
}

const CAP = 500;

export class AdminAudit {
  private readonly db: DatabaseSync;
  constructor(dataDir: string) {
    this.db = openDb(join(dataDir, 'admin_audit.db'), [{
      name: '001-admin-audit',
      up: (db: DatabaseSync) => db.exec(`CREATE TABLE admin_audit (
        rowid INTEGER PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT NOT NULL, actor_name TEXT NOT NULL,
        cmd TEXT NOT NULL, target TEXT NOT NULL, args TEXT NOT NULL, reason TEXT NOT NULL,
        outcome TEXT NOT NULL, result TEXT NOT NULL);
        CREATE INDEX admin_audit_ts ON admin_audit (ts)`),
    }]);
  }

  write(r: AuditRow): void {
    this.db.prepare(`INSERT INTO admin_audit (ts, actor, actor_name, cmd, target, args, reason, outcome, result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.ts, r.actor, r.actorName, r.cmd, r.target.slice(0, CAP),
      r.args.slice(0, CAP), r.reason.slice(0, CAP), r.outcome, r.result.slice(0, CAP));
  }

  recent(limit = 100): AuditRow[] {
    return (this.db.prepare(`SELECT ts, actor, actor_name AS actorName, cmd, target, args, reason, outcome, result
      FROM admin_audit ORDER BY rowid DESC LIMIT ?`).all(limit) as unknown as AuditRow[]);
  }
}
