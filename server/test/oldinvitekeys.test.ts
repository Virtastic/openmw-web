// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-40: the invite code is gone. An old config.toml still carrying [login] inviteCode /
// inviteHelpUrl loads, gates nothing, and the server says once that the keys are ignored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { onLog } from '../src/log';
import { tmpDataDir } from './helpers';

test('an old [login] inviteCode loads and is reported as ignored, once', () => {
  const dir = tmpDataDir();
  writeFileSync(join(dir, 'config.toml'),
    '[login]\nallowRegistration = true\ninviteCode = "letmein"\ninviteHelpUrl = "https://discord.gg/x"\n', 'utf8');
  const events: string[] = [];
  const off = onLog((e) => events.push(e.event));
  try {
    const cfg = loadConfig(dir);
    assert.equal(cfg.login.allowRegistration, true);
    assert.equal((cfg.login as unknown as Record<string, unknown>).inviteCode, undefined);
  } finally { off(); }
  assert.equal(events.filter((e) => e === 'config.ignored_invite_code').length, 1);
});

test('a config without the keys says nothing about them', () => {
  const dir = tmpDataDir();
  const events: string[] = [];
  const off = onLog((e) => events.push(e.event));
  try { loadConfig(dir); } finally { off(); }
  assert.equal(events.includes('config.ignored_invite_code'), false);
});
