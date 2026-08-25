// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The shared lobby's rule floor. The shipped defaults are tuned for a handful of friends on a
// self-hosted server; the gateway's public world is a crowd of strangers, and two of those
// defaults are actively wrong there. One of them the code already CLAIMED to enforce and did
// not: maySkipTime's comment read "Public worlds never skip time" while reading a config value
// that defaults to "anyone".
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { tmpDataDir } from './helpers';

// The lobby predicate is (OMW_WORLD_ID set AND mode public) — a GATEWAY world, not merely a
// public one. Set and restore it around each case rather than leaking it into sibling files.
async function withWorldId<T>(id: string | undefined, fn: () => Promise<T>): Promise<T> {
  const had = process.env.OMW_WORLD_ID;
  if (id === undefined) delete process.env.OMW_WORLD_ID;
  else process.env.OMW_WORLD_ID = id;
  try {
    return await fn();
  } finally {
    if (had === undefined) delete process.env.OMW_WORLD_ID;
    else process.env.OMW_WORLD_ID = had;
  }
}

test('the gateway public world hardens its rules: no time skip, wilderness PvP', async (t) => {
  await withWorldId('vvardenfell', async () => {
    const dataDir = tmpDataDir();
    const server = await startServer({
      requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: 'public',
    });
    t.after(() => server.close());
    assert.equal(server.config.rules.timeSkip, 'off', 'one stranger must not fast-forward everyone');
    assert.equal(server.config.rules.pvp, true, 'the lobby needs something to do that is not chat');
    assert.equal(server.config.rules.pvpZone, 'wilderness', 'towns stay places you can stand still in');
  });
});

// NEGATIVE CONTROL #1. A STANDALONE server also defaults to worldMode 'public', but it is that
// operator's real game — not a lobby. Hardening it would be the server overruling their config
// for no reason, so the shipped defaults must survive here unchanged.
test('a standalone public server keeps the shipped co-op defaults', async (t) => {
  await withWorldId(undefined, async () => {
    const dataDir = tmpDataDir();
    const server = await startServer({
      requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: 'public',
    });
    t.after(() => server.close());
    assert.equal(server.config.rules.timeSkip, 'anyone');
    assert.equal(server.config.rules.pvp, false);
  });
});

// NEGATIVE CONTROL #2. It is a FLOOR, not an override: an operator who stated a value keeps it.
// Without this the hardening would silently undo a deliberate choice, which is the failure mode
// that makes operators stop trusting their own config file.
test('an operator who states a rule keeps it, even in the lobby', async (t) => {
  await withWorldId('vvardenfell', async () => {
    const dataDir = tmpDataDir();
    const server = await startServer({
      requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: 'public',
      configOverride: { rules: { timeSkip: 'anyone', pvp: false } },
    });
    t.after(() => server.close());
    assert.equal(server.config.rules.timeSkip, 'anyone', 'stated by the operator, so not floored');
    assert.equal(server.config.rules.pvp, false, 'stated by the operator, so not floored');
    // Unstated, so the floor still applies — proving this is per-key, not all-or-nothing.
    assert.equal(server.config.rules.pvpZone, 'wilderness');
  });
});

// A private/party world is somebody's campaign. It must never inherit lobby rules.
test('a private world is never given lobby rules', async (t) => {
  await withWorldId('priv-ann-12345678', async () => {
    const dataDir = tmpDataDir();
    const server = await startServer({
      requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: 'private',
    });
    t.after(() => server.close());
    assert.equal(server.config.rules.timeSkip, 'anyone');
    assert.equal(server.config.rules.pvp, false);
  });
});
