// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Purple buildings and holes in the terrain on self-hosted servers (2026-10-27): a streamed read
// that failed mid-game left the engine's caches holding the warning image until the player walked
// away and came back. Two halves, pinned here because streamfs.js is browser code with no module
// boundary: an in-game read failure reaches the engine as EIO (its own failure path, nothing
// cached), and a self-host's warm-up holds only a share of the operator's link.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SFS = join(process.cwd(), '..', 'play', 'streamfs.js');
const PAGE = join(process.cwd(), '..', 'play', 'index.html');
const skip = existsSync(SFS) && existsSync(PAGE) ? false : 'play/ is not in this build context';

test('the worker source still parses (it lives in a template literal: a backtick ends it)', { skip }, () => {
  const sfs = readFileSync(SFS, 'utf8');
  const m = /function workerSource\(\) \{\s*return `([\s\S]*?)`;\s*\}/.exec(sfs);
  assert.ok(m, 'workerSource() template not found');
  assert.doesNotThrow(() => new Function(m[1]!));
});

test('an in-game read failure becomes EIO; a boot one still throws for the reload overlay', { skip }, () => {
  const sfs = readFileSync(SFS, 'utf8');
  const read = /read\(stream, buffer, offset, length, position\) \{[\s\S]*?\n      \},/.exec(sfs);
  assert.ok(read, 'makeNode read() not found');
  assert.match(read[0], /__omwRunning === undefined\) throw e;/);
  assert.match(read[0], /throw new FS\.ErrnoError\(29/);
});

test('the warm-up rests in proportion to its fetches, and only prod runs it at full share', { skip }, () => {
  const sfs = readFileSync(SFS, 'utf8');
  const rest = /const rest = \(ms\) => nap\((.*)\);/.exec(sfs);
  assert.ok(rest, 'rest() not found');
  const fn = new Function('share', 'nap', 'ms', `return nap(${rest[1]!});`);
  const id = (x: number) => x;
  assert.equal(fn(0.25, id, 1000), 3000, 'a quarter share rests three times the fetch');
  assert.equal(fn(1, id, 1000), 30, 'full share keeps the old 30 ms');
  assert.equal(fn(undefined, id, 1000), 30);
  const page = readFileSync(PAGE, 'utf8');
  assert.match(page, /virtastic\\\.app\$\/\.test\(location\.hostname\) \? 1 : 0\.25/);
  assert.match(page, /StreamFS\.warm\(WARM_RE, WARM_FIRST, share\)/);
});
