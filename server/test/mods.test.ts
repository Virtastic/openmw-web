// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The mod list document, and what it becomes in openmw.cfg.
//
// The engine is unforgiving about both halves of this: a content= naming a file that is not
// there aborts startup, and a fallback-archive= it cannot resolve throws. So the interesting
// assertions are about what is NOT emitted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { emptyDoc, readModDoc, resolveMods, writeModDoc, type InstalledMod } from '../src/core/mods';
import { buildPeerCfg, detectGameData } from '../src/core/gamedata';
import { saveMods } from '../src/net/admin/api-mods';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'mods-'));

const mod = (over: Partial<InstalledMod> & { slug: string }): InstalledMod => ({
  name: over.slug, archive: `${over.slug}.zip`, source: '', installedAt: '2026-01-01T00:00:00.000Z',
  enabled: true, plugins: [], archives: [], files: 1, bytes: 1, ...over,
});

// --- the document ----------------------------------------------------------------------------

test('a v1 file reads as v2 with no mods, and its load order survives', () => {
  // v1 is what is on disk today. It must keep meaning exactly what it meant.
  const d = tmp();
  writeFileSync(join(d, 'modlist.json'),
    '{"entries":[{"file":"Morrowind.esm","enabled":true},{"file":"Tribunal.esm","enabled":false}]}');
  const doc = readModDoc(d);
  assert.equal(doc.version, 2);
  assert.deepEqual(doc.mods, []);
  assert.deepEqual(doc.entries, [
    { file: 'Morrowind.esm', enabled: true }, { file: 'Tribunal.esm', enabled: false }]);
});

test('a v2 file round-trips', () => {
  const d = tmp();
  const doc = { ...emptyDoc(), mods: [mod({ slug: 'a', plugins: [{ file: 'A.esp', enabled: true }] })] };
  assert.deepEqual(writeModDoc(d, doc), { ok: true });
  assert.deepEqual(readModDoc(d).mods[0]!.plugins, [{ file: 'A.esp', enabled: true }]);
});

test('a missing, corrupt or future file is empty rather than a throw', () => {
  assert.deepEqual(readModDoc(tmp()), emptyDoc());
  const bad = tmp();
  writeFileSync(join(bad, 'modlist.json'), '{not json');
  assert.deepEqual(readModDoc(bad), emptyDoc());
  const future = tmp();
  // Mangling a newer file is worse than ignoring it: the newer writer will be back.
  writeFileSync(join(future, 'modlist.json'), '{"version":9,"entries":[{"file":"X.esp"}],"mods":[]}');
  assert.deepEqual(readModDoc(future), emptyDoc());
});

test('a mod with an unusable slug is dropped on read', () => {
  // The slug becomes a folder name and a URL segment. One that got past an older writer must
  // not be honoured by this reader.
  const d = tmp();
  writeFileSync(join(d, 'modlist.json'), JSON.stringify({
    version: 2, entries: [], mods: [{ slug: '../etc' }, { slug: 'Fine' }, { slug: 'fine-2' }],
  }));
  assert.deepEqual(readModDoc(d).mods.map((m) => m.slug), ['fine-2']);
});

// --- resolving to a stack --------------------------------------------------------------------

test('array order is the data order, and later wins', () => {
  const s = resolveMods({ ...emptyDoc(), mods: [mod({ slug: 'first' }), mod({ slug: 'second' })] });
  assert.deepEqual(s.dataDirs, ['mods/first', 'mods/second']);
});

test('a disabled mod contributes nothing at all', () => {
  const s = resolveMods({ ...emptyDoc(), mods: [
    mod({ slug: 'off', enabled: false, plugins: [{ file: 'Off.esp', enabled: true }], archives: ['Off.bsa'] }),
  ] });
  assert.deepEqual(s.dataDirs, []);
  assert.deepEqual(s.content, []);
  assert.deepEqual(s.archives, []);
});

test('an enabled mod with every plugin switched off STILL gets its data= line', () => {
  // The subtle one. Its meshes and textures are still wanted; dropping the directory with the
  // plugin would silently uninstall half a mod.
  const s = resolveMods({ ...emptyDoc(), mods: [
    mod({ slug: 'textures-only', plugins: [{ file: 'Opt.esp', enabled: false }] }),
  ] });
  assert.deepEqual(s.dataDirs, ['mods/textures-only']);
  assert.deepEqual(s.content, []);
});

test('masters come before plugins across mods', () => {
  const s = resolveMods({ ...emptyDoc(), mods: [
    mod({ slug: 'a', plugins: [{ file: 'A.esp', enabled: true }] }),
    mod({ slug: 'b', plugins: [{ file: 'B.esm', enabled: true }] }),
  ] });
  assert.deepEqual(s.content, ['B.esm', 'A.esp'], 'the engine expects masters first');
});

test('two mods shipping one archive name emit ONE line, and the clash is reported', () => {
  // OpenMW resolves a bare archive name by scanning data= dirs, so only one is addressable.
  // Emitting it twice would not help, and saying nothing would leave the operator puzzled.
  const s = resolveMods({ ...emptyDoc(), mods: [
    mod({ slug: 'one', archives: ['Data.bsa'] }), mod({ slug: 'two', archives: ['Data.bsa'] }),
  ] });
  assert.deepEqual(s.archives, ['Data.bsa']);
  assert.deepEqual(s.bsaCollisions, [{ name: 'data.bsa', owners: ['one', 'two'] }]);
});

test('the same plugin from two mods is emitted once and reported', () => {
  const s = resolveMods({ ...emptyDoc(), mods: [
    mod({ slug: 'one', plugins: [{ file: 'Shared.esp', enabled: true }] }),
    mod({ slug: 'two', plugins: [{ file: 'shared.esp', enabled: true }] }),
  ] });
  assert.deepEqual(s.content, ['Shared.esp']);
  assert.deepEqual(s.contentCollisions, [{ file: 'shared.esp', owners: ['one', 'two'] }]);
});

// --- the generated cfg -----------------------------------------------------------------------

function retail(): string {
  const d = tmp();
  for (const f of ['Morrowind.esm', 'Morrowind.bsa']) writeFileSync(join(d, f), 'x');
  return d;
}

test('the peer cfg gets one data= per mod, in order, after the base game', () => {
  const dir = retail();
  const stack = resolveMods({ ...emptyDoc(), mods: [
    mod({ slug: 'a', plugins: [{ file: 'A.esp', enabled: true }], archives: ['A.bsa'] }),
    mod({ slug: 'b', plugins: [{ file: 'B.esm', enabled: true }] }),
  ] });
  const cfg = buildPeerCfg(detectGameData(dir), '/res', stack).split('\n');

  // Base first so every mod can override it; then mod dirs in list order.
  assert.equal(cfg.indexOf(`data=${dir}`), 1);
  assert.ok(cfg.indexOf(`data=${join(dir, 'mods/a')}`) < cfg.indexOf(`data=${join(dir, 'mods/b')}`));
  // Base content, then mod masters, then mod plugins, and mp.omwscripts still last.
  assert.ok(cfg.indexOf('content=Morrowind.esm') < cfg.indexOf('content=B.esm'));
  assert.ok(cfg.indexOf('content=B.esm') < cfg.indexOf('content=A.esp'));
  assert.equal(cfg.indexOf('content=mp.omwscripts'), cfg.lastIndexOf('content=mp.omwscripts'));
  assert.ok(cfg.indexOf('content=A.esp') < cfg.indexOf('content=mp.omwscripts'));
  // A mod's archive after the base game's, so it wins.
  assert.ok(cfg.indexOf('fallback-archive=Morrowind.bsa') < cfg.indexOf('fallback-archive=A.bsa'));
});

test('no stack means the cfg is exactly what it always was', () => {
  // Every existing caller passes two arguments. This is the guard that they keep working.
  const dir = retail();
  const data = detectGameData(dir);
  assert.equal(buildPeerCfg(data, '/res'), buildPeerCfg(data, '/res', resolveMods(emptyDoc())));
});

// --- the folder scan -------------------------------------------------------------------------

test('the mods folder is invisible to base game detection', () => {
  const dir = retail();
  mkdirSync(join(dir, 'mods', 'a'), { recursive: true });
  writeFileSync(join(dir, 'mods', 'a', 'A.esp'), 'x');
  const r = detectGameData(dir);
  assert.deepEqual(r.contentFiles, ['Morrowind.esm'], 'a mod plugin is not a base game plugin');
});

test('a DIRECTORY named like a plugin is not treated as one', () => {
  // A slug is operator-supplied. Before withFileTypes, a mod folder called "Foo.esm" would have
  // been read as a master and named in content=, which aborts the engine at startup.
  const dir = retail();
  mkdirSync(join(dir, 'Foo.esm'));
  assert.deepEqual(detectGameData(dir).contentFiles, ['Morrowind.esm']);
});

test('.omwscripts is recognised as content', () => {
  // Every Lua mod is one of these, and none of them loaded before.
  const dir = retail();
  writeFileSync(join(dir, 'MyLua.omwscripts'), 'x');
  assert.ok(detectGameData(dir).contentFiles.includes('MyLua.omwscripts'));
});

test('saving a base load order does not delete the installed mods', () => {
  // These share one file. Writing the whole document from one field would have wiped every mod
  // the moment somebody dragged an .esp.
  const d = tmp();
  writeModDoc(d, { ...emptyDoc(), mods: [mod({ slug: 'keepme' })] });
  const gd = retail();
  assert.deepEqual(saveMods(gd, d, [{ file: 'Morrowind.esm', enabled: true }]), { ok: true });
  assert.deepEqual(readModDoc(d).mods.map((m) => m.slug), ['keepme']);
  assert.match(readFileSync(join(d, 'modlist.json'), 'utf8'), /"version": 2/);
});
