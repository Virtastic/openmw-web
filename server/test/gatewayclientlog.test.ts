// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// THE PAGE'S ERROR REPORTER REACHES THE GATEWAY. play/index.html ships warnings and errors to
// POST /clientlog; on the deployed site that lands on the gateway directory, which only a
// world knew how to answer -- so every client-side failure report was a 404 and the two
// sign-in failures of 2026-09-14 had to be reconstructed from the edge access log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { WorldSupervisor } from '../src/gateway/worlds';
import { startDirectory } from '../src/gateway/directory';
import { onLog } from '../src/log';

class FakeChild extends EventEmitter {
  pid = 42;
  kill(sig: string): boolean { queueMicrotask(() => this.emit('exit', 0, sig)); return true; }
}

test('POST /clientlog on the gateway is recorded as client.log', async (t) => {
  const wdir = mkdtempSync(join(tmpdir(), 'omw-gwcl-'));
  const worlds = new WorldSupervisor({
    settings: {
      worldsDir: wdir, gatewayPort: 8080, serverEntry: '/fake/s.mjs', nodeBin: '/fake/node',
      basePort: 43000, maxWorlds: 4, idleReapMs: 60_000, startTimeoutMs: 1000,
      restartBackoffMs: 1000,
      sharedDir: mkdtempSync(join(tmpdir(), 'omw-gwcl-shared-')),
    },
    spawner: () => new FakeChild() as unknown as ChildProcess,
    fetchStatus: async () => ({ playerCount: 0, connectedCount: 0, maxPlayers: 32, name: 'w' }),
  });
  const dir = await startDirectory({ worlds, host: '127.0.0.1', port: 0, maxPerOwner: 4, worldsDir: wdir });
  t.after(async () => { await dir.close(); worlds.stopAll(); });

  const seen: { level: string; text: string }[] = [];
  const off = onLog((e) => { if (e.event === 'client.log') seen.push({ level: e.level, text: String((e as { text?: unknown }).text ?? '') }); });
  t.after(off);

  const res = await fetch(`http://127.0.0.1:${dir.port}/clientlog`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'abc', lines: [
      '[locker] No locker session. Please sign in again.',
      '[mp] Lua error: boom',
      '[assets] pack unavailable, warning only',
    ] }),
  });
  assert.equal(res.status, 204, 'the gateway must answer the reporter, not 404 it');
  assert.ok(seen.some((s) => /No locker session/.test(s.text)), 'the line must land in the server log');
  // LEVEL IS INFERRED SERVER-SIDE, and the regexes doing it had their \b word boundaries stored
  // as backspace bytes -- every client line, "Lua error" included, was logged at info.
  assert.equal(seen.find((s) => /Lua error/.test(s.text))?.level, 'error');
  assert.equal(seen.find((s) => /warning only/.test(s.text))?.level, 'warn');
  assert.equal(seen.find((s) => /No locker session/.test(s.text))?.level, 'info');
});
