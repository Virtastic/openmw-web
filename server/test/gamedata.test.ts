// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Tier detection. The property that matters most is that an EMPTY folder is tier 1 (full
// multiplayer, client-simulated NPCs) and never "multiplayer off" — breaking that would take
// the feature away from every self-hoster who cannot put Morrowind on a server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGameData, buildPeerCfg, gameDataDir } from '../src/core/gamedata';

function dirWith(files: string[]): string {
  const d = mkdtempSync(join(tmpdir(), 'omw-gd-'));
  for (const f of files) writeFileSync(join(d, f), 'x');
  return d;
}

const RETAIL = [
  'Morrowind.esm', 'Morrowind.bsa',
  'Tribunal.esm', 'Tribunal.bsa',
  'Bloodmoon.esm', 'Bloodmoon.bsa',
];

test('an absent folder is tier 1, not an error', () => {
  const r = detectGameData(join(tmpdir(), 'definitely-not-here-' + Date.now()));
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, [], 'absent is not the same as INCOMPLETE');
  assert.match(r.reason, /no game data directory/);
});

test('an empty folder is tier 1 and says so plainly', () => {
  const r = detectGameData(mkdtempSync(join(tmpdir(), 'omw-gd-')));
  assert.equal(r.ok, false);
  assert.match(r.reason, /empty/);
});

test('a full retail set validates, in official load order', () => {
  const r = detectGameData(dirWith(RETAIL));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.contentFiles, ['Morrowind.esm', 'Tribunal.esm', 'Bloodmoon.esm'],
    'official masters keep their canonical order, never alphabetical');
  assert.equal(r.archives.length, 3);
  assert.deepEqual(r.missing, []);
});

test('an .esm without its .bsa is REFUSED and names the archive', () => {
  // The dangerous case: it loads, then simulates marker_error for everything. Worse than
  // empty because it looks like it works.
  const r = detectGameData(dirWith(['Morrowind.esm', 'Morrowind.bsa', 'Tribunal.esm']));
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['Tribunal.bsa']);
  assert.match(r.reason, /Tribunal\.bsa/);
});

test('Morrowind.esm is required — expansions alone are not a world', () => {
  const r = detectGameData(dirWith(['Tribunal.esm', 'Tribunal.bsa']));
  assert.equal(r.ok, false);
  assert.match(r.reason, /Morrowind\.esm/);
});

// NOTE: the alphabetical half of this is NOT negative-controllable on APFS — removing the
// sort still passes here because readdirSync appears to return entries already ordered. The
// sort stays because that is filesystem-dependent and ext4 makes no such promise; just do not
// read a green run as proof that the sort is load-bearing on THIS machine.
test('mods land after the masters: .esm before .esp, each alphabetical', () => {
  const r = detectGameData(dirWith([
    ...RETAIL, 'zzz.esp', 'aaa.esp', 'BetterBodies.esm', 'Aardvark.esm', 'mod.bsa',
  ]));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.contentFiles, [
    'Morrowind.esm', 'Tribunal.esm', 'Bloodmoon.esm',   // official, canonical order
    'Aardvark.esm', 'BetterBodies.esm',                 // mod masters, alphabetical
    'aaa.esp', 'zzz.esp',                               // then plugins, alphabetical
  ]);
  assert.ok(r.archives.includes('mod.bsa'), 'mod archives are registered too');
});

test('casing does not matter — operators copy from Windows installs', () => {
  const r = detectGameData(dirWith(['morrowind.esm', 'MORROWIND.BSA']));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.contentFiles, ['morrowind.esm'], 'the on-disk name is preserved');
});

test('archives never appear as content files', () => {
  const r = detectGameData(dirWith(RETAIL));
  for (const c of r.contentFiles) {
    assert.doesNotMatch(c, /\.bsa$/i, 'a .bsa is data, not a content file');
  }
});

test('the generated cfg has what the spike proved a peer needs', () => {
  const d = dirWith(RETAIL);
  const cfg = buildPeerCfg(detectGameData(d), '/opt/openmw/resources');
  assert.match(cfg, new RegExp(`^data=${d}$`, 'm'));
  assert.match(cfg, /^content=Morrowind\.esm$/m);
  assert.match(cfg, /^fallback-archive=Morrowind\.bsa$/m);
  assert.match(cfg, /^resources=\/opt\/openmw\/resources$/m);
  // mp.omwscripts must be LAST, matching where the browser client appends it.
  const content = cfg.split('\n').filter((l) => l.startsWith('content='));
  assert.equal(content[content.length - 1], 'content=mp.omwscripts');
});

// Binary resolution. The tier2 image relies on the conventional-path probe; an operator
// override must always win over it.
test('findPeerBinary: explicit config wins without probing', async () => {
  const { findPeerBinary } = await import('../src/core/gamedata');
  const r = findPeerBinary('/custom/openmw', () => { throw new Error('must not probe'); });
  assert.equal(r, '/custom/openmw');
});

test('findPeerBinary: empty config probes conventional paths in order', async () => {
  const { findPeerBinary } = await import('../src/core/gamedata');
  const probed: string[] = [];
  const r = findPeerBinary('', (p) => { probed.push(p); return p === '/usr/bin/openmw'; });
  assert.equal(r, '/usr/bin/openmw');
  assert.deepEqual(probed, ['/usr/local/bin/openmw', '/usr/bin/openmw'],
    'stops at the first hit');
});

test('findPeerBinary: nothing found is "", not a throw', async () => {
  const { findPeerBinary } = await import('../src/core/gamedata');
  assert.equal(findPeerBinary('', () => false), '');
});

test('gameDataDir is the conventional path under the data dir', () => {
  assert.equal(gameDataDir('/data'), '/data/gamedata');
});

test('a non-directory path is handled, not thrown on', () => {
  const d = mkdtempSync(join(tmpdir(), 'omw-gd-'));
  const f = join(d, 'afile');
  writeFileSync(f, 'x');
  const r = detectGameData(f);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a directory/);
  mkdirSync(join(d, 'sub'), { recursive: true }); // keep tmp tidy-ish
});

// THE SIM PEER IS MANDATORY. There is no mode to resolve: a deployment either runs its own
// simulation or refuses to start, because a server with no peer has no eligible cell holder
// and its NPCs never move for anyone. What used to live here tested the 'auto'/'on'/'off'
// knob and the tier-1 fallback to client-simulated NPCs; both are gone.
test('a real deployment refuses to boot without game data', async () => {
  const { startServer } = await import('../src/server');
  const { tmpDataDir } = await import('./helpers');
  // requireGameData omitted: this is the production path, where the check is live.
  await assert.rejects(
    () => startServer({ dataDir: tmpDataDir(), port: 0, host: '127.0.0.1' }),
    /no usable game data/,
    'booting without game data must fail loudly, naming what is missing');
});

test('a real deployment refuses to boot without a server password for the peer', async () => {
  const { startServer } = await import('../src/server');
  const { tmpDataDir } = await import('./helpers');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dir = tmpDataDir();
  const gd = join(dir, 'gamedata');
  mkdirSync(gd, { recursive: true });
  for (const f of ['Morrowind.esm', 'Morrowind.bsa']) writeFileSync(join(gd, f), 'x');

  // Game data and a binary present, but no [server].password: the peer's only credential.
  // An empty password now refuses every system connection, so booting would produce a world
  // whose peer can never authenticate -- exactly the silent failure this check exists for.
  await assert.rejects(
    () => startServer({
      dataDir: dir, port: 0, host: '127.0.0.1',
      configOverride: { simPeer: { binary: '/usr/bin/true' }, server: { password: '' } },
    }),
    /password is empty/,
    'no server password must fail at boot, not at the peer\'s first login attempt');
});
