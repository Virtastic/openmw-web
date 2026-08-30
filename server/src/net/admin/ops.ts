// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Two operational odds and ends the dashboard needs from outside its own module: a readable
// view of the metrics registry, and a backup stream.

import { spawn } from 'node:child_process';
import type { ServerResponse } from 'node:http';
import { basename, dirname } from 'node:path';
import { renderMetrics } from '../../metrics';
import { log } from '../../log';

/**
 * The Prometheus registry, regrouped for humans.
 *
 * Reads the SAME renderMetrics() output the /metrics endpoint serves rather than reaching
 * into the counters separately — one source, so the dashboard can never disagree with the
 * scrape a monitoring system sees. Parsing our own text format back is slightly silly, but
 * it is a few lines against keeping a second accessor in step forever.
 */
export function summariseMetrics(): { groups: Record<string, { name: string; value: string }[]> } {
  const groups: Record<string, { name: string; value: string }[]> = {};
  for (const line of renderMetrics().split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const sp = line.lastIndexOf(' ');
    if (sp === -1) continue;
    const name = line.slice(0, sp);
    const value = line.slice(sp + 1);
    // Group on the first underscore-separated word: omwmp_auth_attempts -> "auth".
    const parts = name.replace(/^omwmp_/, '').split('_');
    const group = parts.length > 1 ? parts[0]! : 'general';
    (groups[group] ??= []).push({ name, value });
  }
  return { groups };
}

/**
 * Stream the data directory as a .tar.gz.
 *
 * Shells out to tar rather than adding an archiver dependency: the runtime image is Linux
 * and already has it, and streaming straight to the socket means a multi-gigabyte data dir
 * never has to fit in memory or land on disk as a temp file first.
 *
 * The archive contains password hashes and any configured credentials. The page says so
 * before offering the download — this is a backup, not a shareable diagnostic bundle.
 */
export async function exportDataDir(dataDir: string, res: ServerResponse): Promise<void> {
  const parent = dirname(dataDir);
  const name = basename(dataDir);
  const stamp = new Date().toISOString().slice(0, 10);

  // -C parent <name>: paths inside the archive stay relative, so it extracts into a folder
  // instead of spraying absolute paths over whatever machine unpacks it.
  const tar = spawn('tar', ['-czf', '-', '-C', parent, name], { stdio: ['ignore', 'pipe', 'pipe'] });

  let failed = false;
  tar.on('error', (err) => {
    failed = true;
    log('error', 'admin.export_failed', { error: String(err) });
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'tar is not available in this container' }));
    } else {
      res.destroy();
    }
  });
  let stderr = '';
  tar.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

  res.writeHead(200, {
    'content-type': 'application/gzip',
    'content-disposition': `attachment; filename="openmw-mp-backup-${stamp}.tar.gz"`,
    'cache-control': 'no-store',
  });
  tar.stdout.pipe(res);

  await new Promise<void>((resolve) => {
    tar.on('close', (code) => {
      // tar exits 1 for "file changed as we read it", which is routine on a live server and
      // does not invalidate the archive. Anything higher is a real failure.
      if (code !== null && code > 1 && !failed) {
        log('error', 'admin.export_failed', { code, stderr: stderr.slice(0, 500) });
      }
      resolve();
    });
  });
}
