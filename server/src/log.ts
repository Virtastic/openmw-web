// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Structured single-line JSON logging. No dep.
//
// Three sinks, all fed by the same call:
//   stdout      — what `docker compose logs` shows, and what a supervisor collects.
//   ring buffer — what the dashboard's live log view tails, with no disk read per poll.
//   file        — <dataDir>/logs/server.log, rotated. This is the one that survives a crash.
//
// The file sink is deliberately a plain rotating file rather than journald or the Windows
// event log: this ships to Linux, Windows and macOS hosts, and a file behaves identically on
// all three. Anything platform-native would work on one and silently do nothing on the others.

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  [field: string]: unknown;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) in ORDER ? (process.env.LOG_LEVEL as LogLevel) : 'info';

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

// --- ring buffer ------------------------------------------------------------------------
// Sized for "what just happened" — a few minutes of a busy server. History beyond this is
// the file sink's job, so this stays small enough to never be a memory consideration.
const RING_SIZE = 2000;
const ring: LogEntry[] = [];

/**
 * Most recent entries, newest last, optionally filtered by an event-name prefix.
 *
 * The audit view is just this with filter='admin.' — the admin actions are already
 * structured log events, so a separate audit store would be a second copy of the truth.
 */
export function recentLogs(limit = 200, filter = ''): LogEntry[] {
  const matched = filter === '' ? ring : ring.filter((e) => e.event.startsWith(filter));
  return matched.slice(-Math.max(1, limit));
}

// --- file sink --------------------------------------------------------------------------
const MAX_BYTES = 8 * 1024 * 1024;
const KEEP = 5;
let logPath: string | undefined;
let failedOnce = false;

/** Point the file sink at <dir>/logs/. Safe to call once at boot; no-op if it cannot. */
export function enableFileLog(dir: string): void {
  try {
    const logDir = join(dir, 'logs');
    mkdirSync(logDir, { recursive: true });
    logPath = join(logDir, 'server.log');
  } catch (err) {
    // A read-only or missing data dir must not stop the server from running; stdout still
    // works and that is enough to diagnose why this failed.
    process.stdout.write(JSON.stringify({
      ts: new Date().toISOString(), level: 'warn', event: 'log.file_disabled', error: String(err),
    }) + '\n');
  }
}

/** Read back the on-disk history the ring buffer has already dropped. */
export function readLogFile(limit = 500): LogEntry[] {
  if (!logPath || !existsSync(logPath)) return [];
  try {
    const lines = readFileSync(logPath, 'utf8').split('\n').filter((l) => l !== '');
    const out: LogEntry[] = [];
    for (const line of lines.slice(-limit)) {
      try { out.push(JSON.parse(line) as LogEntry); } catch { /* torn final line: skip */ }
    }
    return out;
  } catch {
    return [];
  }
}

function rotateIfBig(): void {
  if (!logPath) return;
  try {
    if (!existsSync(logPath) || statSync(logPath).size < MAX_BYTES) return;
    const oldest = `${logPath}.${KEEP}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = `${logPath}.${i}`;
      if (existsSync(from)) renameSync(from, `${logPath}.${i + 1}`);
    }
    renameSync(logPath, `${logPath}.1`);
  } catch { /* rotation is best effort; never let it break logging */ }
}

export function log(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const entry: LogEntry = { ts: new Date().toISOString(), level, event, ...fields };
  const line = JSON.stringify(entry);
  process.stdout.write(line + '\n');

  ring.push(entry);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);

  if (logPath) {
    try {
      rotateIfBig();
      appendFileSync(logPath, line + '\n');
    } catch (err) {
      // Report the first failure to stdout and then stay quiet: a full disk would otherwise
      // turn every subsequent log call into two more lines of noise about the same problem.
      if (!failedOnce) {
        failedOnce = true;
        process.stdout.write(JSON.stringify({
          ts: new Date().toISOString(), level: 'error', event: 'log.file_write_failed', error: String(err),
        }) + '\n');
      }
    }
  }
}
