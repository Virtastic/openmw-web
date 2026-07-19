// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// CLI bootstrap: node dist/server.mjs [--data <dir>] [--port <n>]
// Data dir defaults to /data when it exists (container), else ./devdata.
// SIGTERM/SIGINT = graceful close (SessionDisconnect SHUTDOWN + flush); SIGUSR1 = flush.

import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { startServer } from './server';
import { log } from './log';

const { values } = parseArgs({
  options: {
    data: { type: 'string' },
    port: { type: 'string' },
  },
});

const dataDir = values.data ?? (existsSync('/data') ? '/data' : './devdata');
const port = values.port !== undefined ? Number(values.port) : 8080;
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`invalid --port ${values.port}`);
  process.exit(2);
}

const server = await startServer({ dataDir, port });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'server.signal', { signal });
  await server.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGUSR1', () => {
  log('info', 'server.flush_signal', {});
  void server.flush();
});
