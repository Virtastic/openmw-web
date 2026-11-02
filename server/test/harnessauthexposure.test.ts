// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-54: the shipped default keeps the harness login off, and a server that turns it on
// while reachable from outside is reported at startup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harnessAuthExposure, loadConfig } from '../src/config';
import { tmpDataDir } from './helpers';

test('config.default.toml ships allowHarnessAuth = false', () => {
  const toml = readFileSync(new URL('../config.default.toml', import.meta.url), 'utf8');
  assert.match(toml, /^allowHarnessAuth = false$/m);
});

test('harnessAuthExposure: off is never exposed; on is exposed off loopback or with a domain', () => {
  const prev = process.env.OMW_ALLOW_HARNESS_AUTH;
  delete process.env.OMW_ALLOW_HARNESS_AUTH;
  try {
    const off = loadConfig(tmpDataDir());
    assert.equal(off.login.allowHarnessAuth, false);
    assert.equal(harnessAuthExposure(off, '0.0.0.0'), null);
    const on = loadConfig(tmpDataDir(), { login: { allowHarnessAuth: true } });
    assert.equal(harnessAuthExposure(on, '127.0.0.1'), null);
    assert.equal(harnessAuthExposure(on, 'localhost'), null);
    assert.match(harnessAuthExposure(on, '0.0.0.0') ?? '', /0\.0\.0\.0/);
    const public_ = loadConfig(tmpDataDir(), { login: { allowHarnessAuth: true }, setup: { domain: 'play.example.org' } });
    assert.match(harnessAuthExposure(public_, '127.0.0.1') ?? '', /play\.example\.org/);
  } finally {
    if (prev === undefined) delete process.env.OMW_ALLOW_HARNESS_AUTH; else process.env.OMW_ALLOW_HARNESS_AUTH = prev;
  }
});
