// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s175 (#149): a rolling restart threw every connected player out -- "resume token expired or
// unknown", then a spent login ticket. The tickets a graceful shutdown parks now reach the
// next process: once, unexpired, and never from a file a later boot could find again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResumeStore } from '../src/core/resume';

test('parked tickets survive a graceful restart, once', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'resume-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'resume-tickets.json');

  const before = new ResumeStore(120);
  before.park('tok-a', { accountKey: 'a', accountName: 'A', charId: 'c1', cellKey: '-2,-9' });
  before.park('tok-b', { accountKey: 'b', accountName: 'B', charId: 'c2' });
  assert.equal(before.save(file), 2);

  const after = new ResumeStore(120);
  assert.equal(after.load(file), 2);
  assert.equal(existsSync(file), false, 'the file is deleted on read');
  assert.equal(after.claim('tok-a')?.charId, 'c1', 'the same character comes back');
  assert.equal(after.claim('tok-a'), undefined, 'still single-use');
  assert.equal(new ResumeStore(120).load(file), 0, 'a later boot finds nothing');
});

test('an expired or malformed ticket is not restored; a disabled store loads nothing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'resume-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'resume-tickets.json');
  writeFileSync(file, JSON.stringify([
    ['old', { accountKey: 'a', accountName: 'A', expiresAt: Date.now() - 1 }],
    ['bad', { accountName: 'no key', expiresAt: Date.now() + 60_000 }],
    ['ok', { accountKey: 'c', accountName: 'C', expiresAt: Date.now() + 60_000 }],
  ]));
  const s = new ResumeStore(120);
  assert.equal(s.load(file), 1);
  assert.equal(s.claim('ok')?.accountKey, 'c');
  writeFileSync(file, '[]');
  assert.equal(new ResumeStore(0).load(file), 0);
  assert.equal(new ResumeStore(120).save(join(dir, 'none.json')), 0, 'nothing parked, nothing written');
  assert.equal(existsSync(join(dir, 'none.json')), false);
});
