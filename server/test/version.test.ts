// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// One version, one source.
//
// VERSION was a hardcoded literal that sat at 1.1.0 while v1.2.0 shipped, so a freshly
// updated server kept telling its operator an update was available. It now comes from
// package.json, and the release workflow refuses a tag that does not match it — pinned
// here from both ends so neither half can quietly regress.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('VERSION is package.json, not a copy of it', async () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as
    { version: string };
  const { VERSION } = await import('../src/server');
  assert.equal(VERSION, pkg.version);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});

test('the release workflow refuses a tag that does not match the version', () => {
  const wf = readFileSync(join(process.cwd(), '..', '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(wf, /Version guard/);
  // The guard must not need node: the self-hosted release runner does not have it.
  assert.ok(wf.includes(`json.load(open('server/package.json'))['version']`));
  assert.ok(!wf.includes('node -p'), 'the runner has no node; the guard must stay python3');
  // The guard must run BEFORE anything is built or published.
  assert.ok(wf.indexOf('Version guard') < wf.indexOf('Build engine image'),
    'guarding after the build wastes an hour before failing');
});
