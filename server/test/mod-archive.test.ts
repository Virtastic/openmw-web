// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Finding the data folder inside a mod archive.
//
// These cases are the real shapes Nexus archives come in. There is no packaging standard for
// Morrowind, so this is the function that decides whether an install works or produces a game
// that starts and then breaks somewhere else entirely.

import test from 'node:test';
import assert from 'node:assert/strict';

import { findDataFolders, slugify } from '../src/core/mod-archive';

/** Terser than writing {path,size,isDir} out; a trailing slash means a directory entry. */
const z = (...paths: string[]) =>
  paths.map((p) => ({ path: p.replace(/\/$/, ''), size: p.endsWith('/') ? 0 : 100, isDir: p.endsWith('/') }));

test('a plugin and assets at the root is ONE candidate, not one per subfolder', () => {
  // The commonest shape, and the one an ancestor rule has to get right: Meshes/ and Textures/
  // are this mod's content, not alternatives to it.
  const c = findDataFolders(z('Better Bodies.esp', 'Meshes/x.nif', 'Textures/y.dds', 'readme.txt'));
  assert.equal(c.length, 1);
  assert.equal(c[0]!.path, '');
  assert.deepEqual(c[0]!.plugins, ['Better Bodies.esp']);
  assert.deepEqual(c[0]!.assetDirs, ['Meshes', 'Textures']);
});

test('variants under a bare root are separate candidates', () => {
  // The root holds nothing but folders and a readme, so each folder stands on its own. This is
  // the case the operator must be asked about.
  const c = findDataFolders(z(
    'readme.txt',
    '00 Core/Tamriel_Data.esm', '00 Core/Meshes/a.nif',
    '01 Optional Textures/Textures/b.dds',
    '02 MCP Patch/Patch.esp',
  ));
  assert.deepEqual(c.map((x) => x.path).sort(), ['00 Core', '01 Optional Textures', '02 MCP Patch']);
  assert.deepEqual(c.find((x) => x.path === '01 Optional Textures')!.plugins, [],
    'an asset-only variant is still a candidate');
});

test('a deeply buried Data Files folder is found', () => {
  const c = findDataFolders(z('MyMod-4.0/Data Files/Foo.esp', 'MyMod-4.0/Data Files/Meshes/x.nif',
    'MyMod-4.0/readme.txt'));
  assert.equal(c.length, 1);
  assert.equal(c[0]!.path, 'MyMod-4.0/Data Files');
});

test('a qualifying root swallows a plugin in a subfolder', () => {
  // Deliberately conservative: this is one data folder that happens to have an extra directory,
  // and the operator can see the file list. Splitting it would install the same mod twice.
  const c = findDataFolders(z('Meshes/x.nif', 'Extra/Foo.esp'));
  assert.equal(c.length, 1);
  assert.equal(c[0]!.path, '');
});

test('an archive with no game data in it yields nothing', () => {
  assert.deepEqual(findDataFolders(z('readme.txt', 'screenshot.png', 'docs/manual.pdf')), []);
});

test('fomod, __MACOSX and dotfiles are never candidates', () => {
  // A fomod folder holds the installer script, not data; __MACOSX is packaging debris.
  const c = findDataFolders(z('fomod/ModuleConfig.xml', 'fomod/info.xml',
    '__MACOSX/._Foo.esp', '.hidden/Foo.esp', '00 Core/Foo.esp'));
  assert.deepEqual(c.map((x) => x.path), ['00 Core']);
});

test('archives count as data even with no plugin beside them', () => {
  const c = findDataFolders(z('00 Core/Tamriel_Data.bsa'));
  assert.equal(c.length, 1);
  assert.deepEqual(c[0]!.archives, ['Tamriel_Data.bsa']);
});

test('a Lua-only mod is found — .omwscripts is a plugin', () => {
  // The rest of this codebase did not recognise .omwscripts at all, so a Lua mod would have
  // installed and silently never loaded.
  const c = findDataFolders(z('MyLuaMod/init.omwscripts', 'MyLuaMod/scripts/x.lua'));
  assert.equal(c.length, 1);
  assert.deepEqual(c[0]!.plugins, ['init.omwscripts']);
});

test('candidates with plugins are offered first', () => {
  const c = findDataFolders(z('01 Textures/Textures/a.dds', '01 Textures/Textures/b.dds',
    '02 Core/Foo.esp'));
  assert.equal(c[0]!.path, '02 Core', 'the one with a plugin should be top of the list');
});

test('file counts and sizes cover the whole subtree', () => {
  const c = findDataFolders(z('00 Core/Foo.esp', '00 Core/Meshes/a.nif', '00 Core/Meshes/b.nif'));
  assert.equal(c[0]!.files, 3);
  assert.equal(c[0]!.bytes, 300);
});

test('directories are found even when the zip lists no directory entries', () => {
  // Plenty of zips contain only file records. Without walking the path upward, "00 Core" would
  // never be seen as a directory at all.
  const c = findDataFolders([{ path: '00 Core/Meshes/x.nif', size: 10, isDir: false }]);
  assert.deepEqual(c.map((x) => x.path), ['00 Core']);
});

// --- slugs -----------------------------------------------------------------------------------

test('slugs are safe single path segments', () => {
  assert.equal(slugify('Better Bodies 2.2'), 'better-bodies-2-2');
  assert.equal(slugify('Tamriel_Rebuilt-v24.04.zip'), 'tamriel-rebuilt-v24-04');
  assert.equal(slugify('../../etc'), 'etc');
  // Every result must be usable as ONE path segment, whatever went in.
  for (const bad of ['../../etc', '  ', '!!!', 'a/b/c', 'CON:', '..']) {
    assert.match(slugify(bad), /^[a-z0-9-]{1,64}$/, `slugify(${JSON.stringify(bad)})`);
  }
  assert.match(slugify('!!!'), /^mod-/, 'an empty slug would resolve to the mods root itself');
  assert.match(slugify('mods'), /^mod-/, '"mods" would nest the folder inside itself');
});
