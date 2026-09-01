// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The server's half of the click-to-update contract with the updater container.
//
// The two sides never talk over the network. The server WRITES a flag file into the data
// dir when the owner clicks Update, and READS the status files the updater maintains; the
// updater (deploy/updater.sh) polls for the flag, acts, and reports. Everything is a file
// under ./data because that is the one place both containers already share, and files are
// exactly as reachable as the deployment's volumes - no new attack surface.

import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TAG_RE = /^v[0-9A-Za-z.\-]{1,32}$/;
/** A request older than this is stale: the updater consumes it but refuses to act. */
const FLAG_FRESH_MS = 15 * 60 * 1000;
/** A heartbeat older than this means the updater container is not running. */
const AGENT_ALIVE_MS = 120 * 1000;

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? v as Record<string, unknown> : null;
  } catch { return null; }
}

const str = (o: Record<string, unknown> | null, k: string): string | null =>
  o && typeof o[k] === 'string' ? o[k] : null;

/**
 * Ask the updater to update the server to `tag`.
 *
 * The tag is recorded for the audit trail only - the updater computes the tag to check out
 * from git itself and never executes anything from this file. A fresh pending request is a
 * refusal rather than a rewrite, so two owners clicking at once watch one update.
 */
export function requestServerUpdate(dataDir: string, tag: string, by: string):
{ ok: true } | { ok: false; busy?: boolean; error: string } {
  if (!TAG_RE.test(tag)) return { ok: false, error: 'that does not look like a release tag' };
  const flag = join(dataDir, 'update-requested');
  try {
    if (Date.now() - statSync(flag).mtimeMs < FLAG_FRESH_MS) {
      return { ok: false, busy: true, error: 'an update is already requested' };
    }
  } catch { /* no pending flag: the normal case */ }
  try {
    // Temp+rename so the updater can never read half a file.
    const tmp = `${flag}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ tag, by, at: new Date().toISOString() })}\n`);
    renameSync(tmp, flag);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `could not write the update request: ${String(e)}` };
  }
}

/** Everything the dashboard's server-update card needs, in one parse-tolerant read. */
export function updateStatus(dataDir: string): {
  agent: { alive: boolean; ready: boolean; reason: string | null; at: string | null };
  requested: { tag: string | null; at: string | null } | null;
  status: {
    phase: string | null; tag: string | null; startedAt: string | null;
    updatedAt: string | null; error: string | null;
  } | null;
} {
  const agent = readJson(join(dataDir, 'update-agent.json'));
  let alive = false;
  try {
    alive = Date.now() - statSync(join(dataDir, 'update-agent.json')).mtimeMs < AGENT_ALIVE_MS;
  } catch { /* no heartbeat file: never ran */ }
  const req = readJson(join(dataDir, 'update-requested'));
  const st = readJson(join(dataDir, 'update-status.json'));
  return {
    agent: {
      alive,
      ready: agent?.ready === true,
      reason: str(agent, 'reason') || null,
      at: str(agent, 'at'),
    },
    requested: req ? { tag: str(req, 'tag'), at: str(req, 'at') } : null,
    status: st ? {
      phase: str(st, 'phase'),
      tag: str(st, 'tag'),
      startedAt: str(st, 'startedAt'),
      updatedAt: str(st, 'updatedAt'),
      error: str(st, 'error') || null,
    } : null,
  };
}
