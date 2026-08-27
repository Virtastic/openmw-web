// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The engine gate, as an ACTUAL control rather than a consistency report.
//
// Two holes it had: an empty hash passed unconditionally (so anything opted out of "refuse" by
// declining to identify itself), and the canonical build was adopted from whichever client
// arrived first (so on an empty server an attacker defines the standard everyone else fails).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineGate } from '../src/core/manifest';

const OURS = 'a1b2c3d4e5f6';
const THEIRS = '000000000000';

test('refuse: a client that will not say what it is does not get in', () => {
  const gate = new EngineGate('refuse');
  const r = gate.check('');
  assert.equal(r.ok, false, 'an absent hash used to be a free pass through refuse mode');
});

// NEGATIVE CONTROL for the above. warn KEEPS the exemption: an unstamped local dev build
// legitimately sends '', and warn reports rather than gates. If this ever starts failing, the
// fix above has been over-applied and every dev build is locked out.
test('warn: an absent hash is still admitted, because dev builds send one', () => {
  assert.equal(new EngineGate('warn').check('').ok, true);
  assert.equal(new EngineGate('off').check('').ok, true);
});

test('pin: the operator states the build, so the first arrival cannot define it', () => {
  const gate = new EngineGate('refuse', OURS);
  assert.equal(gate.check(THEIRS).ok, false, 'arriving first buys nothing against a pin');
  assert.equal(gate.check(OURS).ok, true, 'our own build still connects');
});

// NEGATIVE CONTROL: unpinned, the SAME call order admits THEIRS — which is the adopt-first
// behaviour, and is why the pin exists. Proves the refusal above is the pin working.
test('unpinned: the first client through the door sets the standard', () => {
  const gate = new EngineGate('refuse');
  assert.equal(gate.check(THEIRS).ok, true, 'adopted as canonical');
  assert.equal(gate.check(OURS).ok, false, 'and now OUR build is the mismatch');
});

test('a pin survives the server emptying; an adopted canonical does not', () => {
  const pinned = new EngineGate('refuse', OURS);
  assert.equal(pinned.check(OURS).ok, true);
  pinned.release(); // last player out
  assert.equal(pinned.check(THEIRS).ok, false, 'the pin is still the pin');

  const adopted = new EngineGate('refuse');
  assert.equal(adopted.check(OURS).ok, true);
  adopted.release();
  assert.equal(adopted.check(THEIRS).ok, true, 'forgotten, as documented, when unpinned');
});

// THE TRAP THIS NEARLY WALKED INTO. Closing the empty-hash bypass makes `refuse` reject any
// client that will not identify itself — including, without an exemption, THE SIM PEER. It is
// spawned by this server without OPENMW_MP_ENGINEHASH so it sends '', and it is a NATIVE build
// whose hash could never equal the wasm one a pin names even if it did send one.
//
// Refusing it is the worst available failure: no holder for any cell, every NPC frozen, and a
// server that reports itself perfectly healthy while nothing in the world moves.
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

test('refuse mode does not lock the sim peer out of its own world', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { engine: { enforce: 'refuse', pin: OURS }, server: { password: 'peer-secret-1' } },
  });
  t.after(() => server.close());

  const peer = await TestClient.connect(server.port);
  peer.sendJson({
    t: 'SessionHello', proto: 1, engineHash: '', lserVersion: 0, manifest: [],
    system: true, simulatesActors: true,
  });
  const hello = await peer.waitJson('SessionHelloOk');
  assert.ok(hello, 'the peer was refused at Hello by the engine gate');
  peer.close();
});

// NEGATIVE CONTROL: an ORDINARY client sending the same empty hash is still refused, so the
// exemption above is scoped to the system peer rather than reopening the bypass for everyone.
test('...but an ordinary client with no hash still is', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { engine: { enforce: 'refuse', pin: OURS } },
  });
  t.after(() => server.close());

  const c = await TestClient.connect(server.port);
  c.sendJson({ t: 'SessionHello', proto: 1, engineHash: '', lserVersion: 0, manifest: [] });
  const bye = await c.waitJson('SessionDisconnect');
  assert.equal((bye as { code?: string }).code, 'BAD_ENGINE');
  c.close();
});

// ---------------------------------------------------------------- the pin's SOURCE
//
// The gate above is only as good as the value handed to it, and that value is where the
// operational danger lives. A pin typed into config.toml is a 12-hex constant that has to be
// edited in lockstep with every engine deploy; in "refuse" mode a pin that no longer matches
// the engine being served refuses EVERY client, honest ones included. An outage caused by the
// security control is the worst kind, and it is exactly why enforce has stayed at "warn".
//
// So the deploy supplies it: version-engine.sh writes the hash it just stamped to
// <play>/engine-version.txt, docker-compose passes it as OMW_ENGINE_PIN, and the pin cannot
// drift from what is actually being served. These cover the precedence that makes that safe.
test('pin: OMW_ENGINE_PIN overrides the config file, so the deploy can set it', async () => {
  const { loadConfig } = await import('../src/config');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'omw-pin-'));
  writeFileSync(join(dir, 'config.toml'), '[engine]\npin = "aaaaaaaaaaaa"\n');

  const before = process.env.OMW_ENGINE_PIN;
  try {
    process.env.OMW_ENGINE_PIN = 'bbbbbbbbbbbb';
    assert.equal(loadConfig(dir).engine.pin, 'bbbbbbbbbbbb',
      'the deployed engine must win over a hand-written constant that can go stale');

    // BLANK MUST NOT WIN. An unset-but-present env var (empty string, which is what an
    // unsubstituted ${OMW_ENGINE_PIN:-} becomes) has to fall through to the config file rather
    // than silently CLEARING the operator's pin -- that would turn a stated build back into
    // first-arrival-wins, quietly, on the next deploy.
    process.env.OMW_ENGINE_PIN = '   ';
    assert.equal(loadConfig(dir).engine.pin, 'aaaaaaaaaaaa',
      'a blank env var must fall through to the config, not erase it');

    delete process.env.OMW_ENGINE_PIN;
    assert.equal(loadConfig(dir).engine.pin, 'aaaaaaaaaaaa');
  } finally {
    if (before === undefined) delete process.env.OMW_ENGINE_PIN;
    else process.env.OMW_ENGINE_PIN = before;
  }
});
