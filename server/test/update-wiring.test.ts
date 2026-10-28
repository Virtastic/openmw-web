// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// v2 is hosted-only (CL12): the updater agent and the setup scripts are gone. What is left of
// the update path spans the compose file, the dashboard and the server; these pins hold it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(process.cwd(), '..');
// The Docker test stage carries server/ only; these contracts span repo-root files, so the
// whole suite is environment-gated rather than crashing the gate on a missing file. The
// laptop/CI checkout still runs every pin.
const rootPresent = existsSync(join(root, 'docker-compose.yml'));
const read = (p: string): string => (rootPresent ? readFileSync(join(root, p), 'utf8') : '');

const compose = read('docker-compose.yml');
const app = read('server/web/app.js');

test('compose: the server sees the client dir, and every bind source honours REPO_DIR', (t) => {
  if (!rootPresent) { t.skip('repo root not in this build context'); return; }
  assert.ok(compose.includes('${REPO_DIR:-.}/play:/client'), 'the engine update needs /client');
  const sources = [...compose.matchAll(/^\s+- (\.[^:\n]*):/gm)].map((m) => m[1]);
  assert.deepEqual(sources, [], `relative bind sources left: ${sources.join(', ')}`);
  assert.ok(compose.includes('${REPO_DIR:-.}/data:/data'));
  assert.ok(compose.includes('${REPO_DIR:-.}/play:/srv/client:ro'));
});

test('compose: the server image is pulled from GHCR, pinned by OPENMW_WEB_TAG', (t) => {
  if (!rootPresent) { t.skip('repo root not in this build context'); return; }
  assert.ok(compose.includes('image: ghcr.io/virtastic/openmw-web-server:${OPENMW_WEB_TAG:-latest}'));
  // No build block, and nothing holds the docker socket (the updater that did is gone).
  assert.equal([...compose.matchAll(/^\s+build:/gm)].length, 0, 'no build: block');
  assert.ok(!compose.includes('docker.sock'), 'no container holds the docker socket');
});

test('the dashboard drives both updates through the real routes', (t) => {
  if (!rootPresent) { t.skip('repo root not in this build context'); return; }
  for (const needle of [
    "api('/updates')", "api('/update/status')",
    "api('/update/server', { method: 'POST' })", "api('/update/engine', { method: 'POST' })",
    '/mods/install/progress?token=',
    'waitForRestart()',
    // The terminal-frame contract with startEngineUpdate, pinned from the consuming side
    // (update-engine.test.ts pins the producing side).
    "note.startsWith('done:')", "note.startsWith('error:')",
  ] as const) {
    assert.ok(app.includes(needle), `app.js is missing: ${needle}`);
  }
  assert.ok(app.includes('confirmAction'), 'updates confirm before acting');
  assert.match(app, /never touches your data/i, 'the data-safety promise is stated to the operator');
});

test('applying is never automatic anywhere', (t) => {
  if (!rootPresent) { t.skip('repo root not in this build context'); return; }
  // Nothing but the owner route writes the update flag.
  const server = read('server/src/net/admin/update-server.ts');
  assert.ok(server.includes("join(dataDir, 'update-requested')"));
  const routes = read('server/src/net/admin/routes.ts');
  assert.ok(routes.includes("gate(req, res, auth, 'owner')"), 'update routes are owner-gated');
});
