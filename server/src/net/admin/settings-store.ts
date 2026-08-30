// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The dashboard's own config file: read it, patch one section, write it back safely.
//
// Writes go to <dataDir>/config.dashboard.toml and NEVER to the operator's config.toml.
// smol-toml's stringify drops comments on a round trip, so writing back a hand-authored
// file would quietly delete the reasoning someone left next to their values. A separate
// file also means this process owns something it is allowed to roll back — see the
// fallback ladder in config.ts, which is what stops a bad save from bricking a boot.

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { DASHBOARD_FILE, snapshotNames, checkDashboardTree } from '../../config';
import { log } from '../../log';

export type Tree = Record<string, unknown>;

export function readDashboardTree(dataDir: string): Tree {
  const path = join(dataDir, DASHBOARD_FILE);
  if (!existsSync(path)) return {};
  try {
    return parse(readFileSync(path, 'utf8')) as Tree;
  } catch (err) {
    // Unreadable is not fatal here: boot already fell back past it, and the dashboard should
    // still open so the operator can fix the thing that broke.
    log('error', 'admin.settings_unreadable', { error: String(err) });
    return {};
  }
}

export type SaveResult = { ok: true } | { ok: false; error: string };

/**
 * Merge `patch` into one section of the dashboard override file and persist it.
 *
 * Validation happens against the FULL merged config (defaults + operator + this), not the
 * patch alone, because a field is only ever valid in context — an override that is fine on
 * its own can still contradict something the operator set by hand.
 */
export function saveSection(
  dataDir: string,
  section: string,
  patch: Tree,
  sharedDir?: string,
): SaveResult {
  const current = readDashboardTree(dataDir);
  const existing = (current[section] as Tree | undefined) ?? {};
  const next: Tree = { ...current, [section]: { ...existing, ...patch } };

  const problem = checkDashboardTree(dataDir, next, sharedDir);
  if (problem) return { ok: false, error: problem };

  return writeTree(dataDir, next);
}

/** Replace the whole override file (the raw-TOML editor and the wizard's bulk writes). */
export function saveTree(dataDir: string, next: Tree, sharedDir?: string): SaveResult {
  const problem = checkDashboardTree(dataDir, next, sharedDir);
  if (problem) return { ok: false, error: problem };
  return writeTree(dataDir, next);
}

function writeTree(dataDir: string, next: Tree): SaveResult {
  const path = join(dataDir, DASHBOARD_FILE);
  try {
    rotate(dataDir);
    // Temp file + rename: a crash mid-write leaves the previous file intact rather than a
    // half-written one, which the boot ladder would then have to rescue us from.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, header() + stringify(next), 'utf8');
    renameSync(tmp, path);
    return { ok: true };
  } catch (err) {
    log('error', 'admin.settings_write_failed', { error: String(err) });
    return { ok: false, error: `could not write ${DASHBOARD_FILE}: ${String(err)}` };
  }
}

/** Keep the last N versions so boot can fall back past a bad one. Oldest is dropped. */
function rotate(dataDir: string): void {
  const names = snapshotNames();
  const path = (n: string): string => join(dataDir, n);
  const oldest = path(names[names.length - 1]!);
  try { if (existsSync(oldest)) unlinkSync(oldest); } catch { /* best effort */ }
  for (let i = names.length - 1; i > 0; i--) {
    const from = path(names[i - 1]!);
    if (existsSync(from)) {
      try { renameSync(from, path(names[i]!)); } catch { /* best effort */ }
    }
  }
  const live = join(dataDir, DASHBOARD_FILE);
  if (existsSync(live)) {
    try { renameSync(live, path(names[0]!)); } catch { /* best effort */ }
  }
}

function header(): string {
  return [
    '# Written by the openmw-mp admin dashboard. Safe to delete: everything here is a',
    '# layer ON TOP of your own config.toml, which the dashboard never edits.',
    '#',
    '# Comments you add to THIS file will be lost on the next dashboard save. Put anything',
    '# you want to keep in config.toml instead.',
    '', '',
  ].join('\n');
}
