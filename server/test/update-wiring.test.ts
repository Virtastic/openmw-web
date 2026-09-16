// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The click-to-update feature crosses five files that cannot import each other: the compose
// file, the updater's shell script, the setup scripts, the dashboard, and the server. These
// pins hold the contracts between them, so a change on one side fails a test instead of
// failing an operator's deployment.

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
const updater = read('deploy/updater.sh');
const setupSh = read('setup.sh');
const setupPs = read('setup.ps1');
const app = read('server/web/app.js');

test('compose: the server sees the client dir, and every bind source honours REPO_DIR', (t) => {
  if (!rootPresent) { t.skip('repo root not in this build context'); return; }
  assert.ok(compose.includes('${REPO_DIR:-.}/play:/client'), 'the engine update needs /client');
  // A single relative source would silently break compose when the updater runs it: the
  // path would resolve inside the updater container and be handed to the host daemon.
  const sources = [...compose.matchAll(/^\s+- (\.[^:\n]*):/gm)].map((m) => m[1]);
  assert.deepEqual(sources, [], `relative bind sources left: ${sources.join(', ')}`);
  assert.ok(compose.includes('${REPO_DIR:-.}/data:/data'));
  assert.ok(compose.includes('${REPO_DIR:-.}/play:/srv/client:ro'));
});

test('compose: the updater exists, holds the socket, and the web container does not', (t) => {
  if (!rootPresent) { t.skip('repo root not in this build context'); return; }
  assert.match(compose, /updater:/);
  assert.ok(compose.includes('Dockerfile.updater'));
  assert.ok(compose.includes('/var/run/docker.sock:/var/run/docker.sock'));
  assert.equal(compose.split('docker.sock').length - 1, 2,
    'exactly one socket mount (the mapping line), and it lives in the updater service');
  assert.ok(compose.includes('${REPO_DIR:-.}:/repo'));
});

test('updater.sh: flag content is data, never code', (t) => {
  if (!rootPresent) { t.skip('repo root not in this build context'); return; }
  // The one security property everything rests on: the updater computes the tag from git
  // and only ever logs the flag file. Reading it into a variable that later reaches a
  // command line would break the whole stance.
  assert.ok(updater.includes('git -C "$REPO" tag --sort=-v:refname'), 'the tag comes from git');
  assert.ok(!/\$\(cat "\$FLAG"\)[^)]*\|\s*(sh|git|docker)/.test(updater));
  const catUses = [...updater.matchAll(/cat "\$FLAG"[^\n]*/g)].map((m) => m[0]);
  assert.deepEqual(catUses, ['cat "$FLAG" 2>/dev/null | head -c 500)"'],
    'the flag is read once, for the log line only');
  assert.match(updater, /grep -Eq '\^v\[0-9A-Za-z.-\]\{1,32\}\$'/, 'the computed tag is validated');
});

test('updater.sh: heartbeat, status phases and expiry match what the server parses', (t) => {
  if (!rootPresent) { t.skip('repo root not in this build context'); return; }
  for (const phase of ['pulling', 'restarting', 'done', 'failed']) {
    assert.ok(updater.includes(`status ${phase}`), `phase ${phase}`);
  }
  // NOBODY WHO SELF-HOSTS COMPILES ANYTHING: the server image is pulled from GHCR (the
  // release workflow built it), never built on the box. The pull happens BEFORE the tag is
  // pinned in .env, so a failed pull leaves the running container and .env untouched.
  assert.ok(!updater.includes('status building'), 'no build phase any more');
  assert.ok(!/docker compose build/.test(updater), 'the updater never builds');
  assert.match(updater, /docker compose pull openmw-web/, 'the updater pulls the image');
  assert.ok(updater.indexOf('docker compose pull openmw-web') < updater.indexOf("printf 'OPENMW_WEB_TAG=%s\\n'"),
    'the pull precedes the .env pin');
  assert.ok(updater.indexOf("printf 'OPENMW_WEB_TAG=%s\\n'") < updater.indexOf('docker compose up -d openmw-web'),
    'the .env pin precedes the restart');
  assert.ok(updater.includes('update-agent.json'));
  assert.ok(updater.includes('update-requested'));
  assert.ok(updater.includes('update-status.json'));
  assert.ok(updater.includes('rm -f "$FLAG"'), 'the flag is consumed before acting');
  assert.ok(updater.includes('900'), 'stale requests expire instead of firing');
  assert.ok(updater.includes('com.docker.compose.project'),
    'compose must reuse the host project name or container_name collides');
});

test('setup scripts: tag-pinned, OPENMW_WEB_TAG + REPO_DIR written, pull not build', (t) => {
  if (!rootPresent) { t.skip('repo root not in this build context'); return; }
  for (const [name, script] of [['setup.sh', setupSh], ['setup.ps1', setupPs]] as const) {
    assert.ok(script.includes("-l 'v*' --sort=-v:refname"), `${name} checks out the newest v* tag`);
    assert.ok(script.includes('fetch --tags'), `${name} fetches tags`);
    assert.ok(script.includes('REPO_DIR'), `${name} writes REPO_DIR`);
    assert.ok(script.includes('OPENMW_WEB_TAG'), `${name} pins the image tag in .env`);
    assert.match(script, /(\$DC|Invoke-Compose) pull openmw-web/, `${name} pulls the server image`);
    // The one image still built on the box is the updater (seconds of alpine). A bare
    // `compose build` coming back would mean a self-hoster compiling OpenMW again.
    assert.ok(!/^\s*(\$DC|Invoke-Compose) build/m.test(script), `${name} never runs compose build`);
  }
});

test('compose: the server image is pulled from GHCR, pinned by OPENMW_WEB_TAG', (t) => {
  if (!rootPresent) { t.skip('repo root not in this build context'); return; }
  assert.ok(compose.includes('image: ghcr.io/virtastic/openmw-web-server:${OPENMW_WEB_TAG:-latest}'));
  // Only the updater keeps a build block; a second one means the server is built locally again.
  assert.equal([...compose.matchAll(/^\s+build:/gm)].length, 1, 'exactly one build: block (the updater)');
  const release = read('.github/workflows/release.yml');
  assert.ok(release.includes('ghcr.io/virtastic/openmw-web-server'), 'the release publishes that image');
  assert.ok(release.includes('-f server/Dockerfile.simpeer --target tier2'), 'the multiplayer-capable one');
  assert.ok(release.includes('packages: write'));
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
  // The updater acts only when the flag exists, and nothing but the owner route writes it.
  assert.ok(updater.includes('if [ -f "$FLAG" ]'));
  const server = read('server/src/net/admin/update-server.ts');
  assert.ok(server.includes("join(dataDir, 'update-requested')"));
  const routes = read('server/src/net/admin/routes.ts');
  assert.ok(routes.includes("gate(req, res, auth, 'owner')"), 'update routes are owner-gated');
});
