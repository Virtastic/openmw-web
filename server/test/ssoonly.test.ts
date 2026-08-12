// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// SSO-ONLY IS A CONFIG DECISION, AND requireSso MUST ACTUALLY FORCE IT.
//
// The shipped defaults are permissive (requireSso = false, allowPasswordLogin = true) because
// self-hosters are a real audience. The hosted product is not that audience: a persistent
// cross-world character needs a durable identity, and an open password path is a second
// credential store to breach and a second identity for the same player. The live dev
// deployment was found serving allowPasswordLogin = true with all three providers configured,
// which is why the front door now warns about exactly that combination.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDataDir } from './helpers';

function cfg(toml: string): ReturnType<typeof loadConfig> {
  const dir = tmpDataDir();
  writeFileSync(join(dir, 'config.toml'), toml, 'utf8');
  return loadConfig(dir);
}

const GOOGLE = '[auth.google]\nenabled = true\nclientId = "cid"\nclientSecret = "secret"\n';

test('requireSso forces password login off, whatever the operator also wrote', () => {
  const c = cfg('[auth]\nrequireSso = true\nallowPasswordLogin = true\nreturnUrl = "https://x/"\n' + GOOGLE);
  assert.equal(c.auth.requireSso, true);
  assert.equal(c.auth.allowPasswordLogin, false,
    'requireSso must win over an explicit allowPasswordLogin — otherwise the SSO-only promise '
    + 'is only as good as the operator remembering to set two flags consistently');
});

test('the permissive default is preserved for self-hosters', () => {
  const c = cfg('[auth]\nreturnUrl = "https://x/"\n');
  assert.equal(c.auth.requireSso, false);
  assert.equal(c.auth.allowPasswordLogin, true,
    'a self-hoster who configures nothing must still be able to run account+password');
});

// SSO-only with no provider would lock everyone out, so loadConfig refuses the combination.
// Worth pinning: it is what stops "just set requireSso" being a foot-gun on a deployment that
// has not configured a provider yet.
test('requireSso without any provider is refused rather than locking everyone out', () => {
  assert.throws(
    () => cfg('[auth]\nrequireSso = true\nreturnUrl = "https://x/"\n'),
    /requireSso must be false unless an SSO provider is enabled/);
});
