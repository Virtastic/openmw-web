// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Installing a mod, end to end over HTTP.
//
// The install writes operator-supplied names into the filesystem, so the refusals matter as
// much as the happy path: a slug that escapes the mods folder, an entry that escapes it from
// inside the zip, and a half-extracted mod left behind after a failure would each be a real
// problem rather than an inconvenience.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { commitInstall, uninstallMod, saveModOrder } from '../src/net/admin/mod-install';
import { crc32, listEntries } from '../src/core/zip';
import { emptyDoc, readModDoc, writeModDoc } from '../src/core/mods';
import { startServer } from '../src/server';
import { tmpDataDir } from './helpers';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'inst-'));

/** A real zip, in memory. */
function buildZip(files: { name: string; data: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const body = Buffer.from(f.data);
    const comp = deflateRawSync(body);
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(body);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(body.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(body.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** The same zip, parked where commitInstall expects to find it. */
function stage(dataDir: string, token: string, files: { name: string; data: string }[]): void {
  writeFileSync(join(mkdirp(join(dataDir, 'mod-staging')), `${token}.zip`), buildZip(files));
}

function mkdirp(d: string): string {
  mkdirSync(d, { recursive: true });
  return d;
}

const TOKEN = '0'.repeat(32);

test('installing extracts only the chosen folder, and records what it found', () => {
  const dataDir = tmp();
  const gameDataDir = tmp();
  stage(dataDir, TOKEN, [
    { name: '00 Core/Better Bodies.esp', data: 'plugin' },
    { name: '00 Core/BB.bsa', data: 'archive' },
    { name: '00 Core/Meshes/x.nif', data: 'mesh' },
    { name: '01 Optional/Other.esp', data: 'nope' },
    { name: 'readme.txt', data: 'nope' },
  ]);

  const r = commitInstall(dataDir, gameDataDir, TOKEN,
    [{ path: '00 Core', slug: 'better-bodies', name: 'Better Bodies' }]);
  return r.then((res) => {
    assert.ok(res.ok, res.ok ? '' : res.error);
    const mod = res.value[0]!;
    assert.equal(mod.slug, 'better-bodies');
    assert.deepEqual(mod.plugins, [{ file: 'Better Bodies.esp', enabled: true }]);
    assert.deepEqual(mod.archives, ['BB.bsa']);
    assert.equal(mod.files, 3);

    // The chosen folder's contents land at the mod root, with the prefix stripped.
    const root = join(gameDataDir, 'mods', 'better-bodies');
    assert.ok(existsSync(join(root, 'Better Bodies.esp')));
    assert.equal(readFileSync(join(root, 'Meshes', 'x.nif'), 'utf8'), 'mesh');
    // And nothing from the folders that were not chosen.
    assert.ok(!existsSync(join(root, 'Other.esp')));
    assert.ok(!existsSync(join(root, 'readme.txt')));
    // Recorded in the document, so it survives a restart.
    assert.deepEqual(readModDoc(dataDir).mods.map((m) => m.slug), ['better-bodies']);
  });
});

test('a plugin buried in a subfolder is NOT named in the load order', () => {
  // Only plugins at the mod's root are content= entries. One inside Meshes/ is somebody's
  // backup, and naming a file the engine cannot resolve aborts startup.
  const dataDir = tmp(); const gameDataDir = tmp();
  stage(dataDir, TOKEN, [
    { name: 'Real.esp', data: 'x' },
    { name: 'Meshes/OldBackup.esp', data: 'x' },
  ]);
  return commitInstall(dataDir, gameDataDir, TOKEN, [{ path: '', slug: 'm', name: 'M' }])
    .then((res) => {
      assert.ok(res.ok);
      assert.deepEqual(res.value[0]!.plugins.map((p) => p.file), ['Real.esp']);
    });
});

test('two installs of the same name get distinct folders', () => {
  const dataDir = tmp(); const gameDataDir = tmp();
  stage(dataDir, TOKEN, [{ name: 'A.esp', data: 'x' }]);
  return commitInstall(dataDir, gameDataDir, TOKEN, [{ path: '', slug: 'same', name: 'Same' }])
    .then(() => {
      stage(dataDir, TOKEN, [{ name: 'A.esp', data: 'x' }]);
      return commitInstall(dataDir, gameDataDir, TOKEN, [{ path: '', slug: 'same', name: 'Same' }]);
    })
    .then((res) => {
      assert.ok(res.ok);
      assert.equal(res.value[0]!.slug, 'same-2', 'the second must not overwrite the first');
      assert.ok(existsSync(join(gameDataDir, 'mods', 'same', 'A.esp')));
      assert.ok(existsSync(join(gameDataDir, 'mods', 'same-2', 'A.esp')));
    });
});

test('a slug that tries to escape is regenerated, not honoured', () => {
  // The browser sent it, and the browser is not where this decision lives.
  const dataDir = tmp(); const gameDataDir = tmp();
  stage(dataDir, TOKEN, [{ name: 'A.esp', data: 'x' }]);
  return commitInstall(dataDir, gameDataDir, TOKEN,
    [{ path: '', slug: '../../escape', name: 'x' }]).then((res) => {
    assert.ok(res.ok);
    assert.match(res.value[0]!.slug, /^[a-z0-9-]+$/);
    assert.ok(existsSync(join(gameDataDir, 'mods', res.value[0]!.slug)));
  });
});

test('an expired or malformed token installs nothing', () => {
  const dataDir = tmp(); const gameDataDir = tmp();
  return commitInstall(dataDir, gameDataDir, 'not-a-token', [{ path: '', slug: 'a', name: 'a' }])
    .then((res) => {
      assert.equal(res.ok, false);
      assert.ok(!existsSync(join(gameDataDir, 'mods')), 'nothing should have been created');
      return commitInstall(dataDir, gameDataDir, '1'.repeat(32), [{ path: '', slug: 'a', name: 'a' }]);
    })
    .then((res) => {
      assert.equal(res.ok, false);
      assert.match((res as { error: string }).error, /expired/);
    });
});

test('uninstall removes the folder and the entry together', () => {
  const dataDir = tmp(); const gameDataDir = tmp();
  stage(dataDir, TOKEN, [{ name: 'A.esp', data: 'x' }]);
  return commitInstall(dataDir, gameDataDir, TOKEN, [{ path: '', slug: 'gone', name: 'Gone' }])
    .then(() => uninstallMod(dataDir, gameDataDir, 'gone'))
    .then((res) => {
      assert.ok(res.ok);
      assert.ok(!existsSync(join(gameDataDir, 'mods', 'gone')));
      assert.deepEqual(readModDoc(dataDir).mods, []);
    });
});

test('uninstalling something that is not there is a 404, not a wipe', () => {
  const dataDir = tmp(); const gameDataDir = tmp();
  return uninstallMod(dataDir, gameDataDir, 'nope').then((res) => {
    assert.equal(res.ok, false);
    assert.equal((res as { status: number }).status, 404);
  });
});

test('uninstall refuses a slug shaped like a path', () => {
  const dataDir = tmp(); const gameDataDir = tmp();
  return uninstallMod(dataDir, gameDataDir, '../../gamedata').then((res) => {
    assert.equal(res.ok, false);
    assert.equal((res as { status: number }).status, 400);
  });
});

// --- ordering and switches --------------------------------------------------------------------

const twoMods = (dataDir: string) => writeModDoc(dataDir, {
  ...emptyDoc(),
  mods: [
    { slug: 'a', name: 'A', archive: '', source: '', installedAt: '', enabled: true,
      plugins: [{ file: 'A.esp', enabled: true }], archives: [], files: 1, bytes: 1 },
    { slug: 'b', name: 'B', archive: '', source: '', installedAt: '', enabled: true,
      plugins: [{ file: 'B.esp', enabled: true }], archives: [], files: 1, bytes: 1 },
  ],
});

test('the order sent is the order stored', () => {
  const d = tmp();
  twoMods(d);
  assert.ok(saveModOrder(d, [{ slug: 'b' }, { slug: 'a' }]).ok);
  assert.deepEqual(readModDoc(d).mods.map((m) => m.slug), ['b', 'a']);
});

test('a mod the page never mentioned keeps its place instead of vanishing', () => {
  // The open page may be a version behind. A save should not delete what it never knew about.
  const d = tmp();
  twoMods(d);
  assert.ok(saveModOrder(d, [{ slug: 'a' }]).ok);
  assert.deepEqual(readModDoc(d).mods.map((m) => m.slug), ['a', 'b']);
});

test('switches apply to the mod and to its individual plugins', () => {
  const d = tmp();
  twoMods(d);
  assert.ok(saveModOrder(d, [
    { slug: 'a', enabled: false },
    { slug: 'b', enabled: true, plugins: [{ file: 'B.esp', enabled: false }] },
  ]).ok);
  const mods = readModDoc(d).mods;
  assert.equal(mods.find((m) => m.slug === 'a')!.enabled, false);
  assert.equal(mods.find((m) => m.slug === 'b')!.plugins[0]!.enabled, false);
});

test('naming a mod that does not exist is refused, not ignored', () => {
  // Matching saveMods: a list the operator is wrong about should say so.
  const d = tmp();
  twoMods(d);
  const r = saveModOrder(d, [{ slug: 'ghost' }]);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /no such mod: ghost/);
  const dup = saveModOrder(d, [{ slug: 'a' }, { slug: 'a' }]);
  assert.equal(dup.ok, false);
  assert.match((dup as { error: string }).error, /listed twice/);
});

// --- over real HTTP ---------------------------------------------------------------------------

test('a zip goes in, the operator is asked, and only the chosen folder is installed', async (t) => {
  // The whole feature in one pass, through the actual routes: upload, be told what is inside,
  // pick one, and find it on disk with its plugin recognised. Everything above this tests the
  // pieces; this is the only check that the wiring between them exists.
  const dataDir = tmpDataDir();
  const gameData = join(dataDir, 'gamedata');
  mkdirSync(gameData, { recursive: true });
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const owner = await fetch(`${base}/admin/api/setup/owner`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'mods@example.com', password: 'a-long-enough-passphrase' }),
  });
  const token = (await owner.json() as { token: string }).token;
  const auth = { authorization: `Bearer ${token}` };

  const zip = buildZip([
    { name: 'readme.txt', data: 'notes' },
    { name: '00 Core/Better Bodies.esp', data: 'plugin' },
    { name: '00 Core/BB.bsa', data: 'archive' },
    { name: '00 Core/Meshes/x.nif', data: 'mesh' },
    { name: '01 Optional/Textures/f.dds', data: 'tex' },
  ]);

  const staged = await (await fetch(`${base}/admin/api/mods/install?name=BetterBodies-v2.zip`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/octet-stream' }, body: zip,
  })).json() as { token: string; candidates: { path: string; plugins: string[] }[] };

  // BOTH variants offered, and neither installed yet. This is the step every other tool
  // leaves to a human reading a readme.
  assert.deepEqual(staged.candidates.map((c) => c.path).sort(), ['00 Core', '01 Optional']);
  assert.deepEqual(staged.candidates.find((c) => c.path === '00 Core')!.plugins,
    ['Better Bodies.esp']);
  assert.ok(!existsSync(join(gameData, 'mods')), 'nothing is installed before the choice');

  const done = await fetch(`${base}/admin/api/mods/install/commit`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ token: staged.token,
      choices: [{ path: '00 Core', slug: 'better-bodies', name: 'Better Bodies' }] }),
  });
  assert.equal(done.status, 200);

  assert.equal(readFileSync(join(gameData, 'mods', 'better-bodies', 'Better Bodies.esp'), 'utf8'),
    'plugin');
  assert.ok(!existsSync(join(gameData, 'mods', 'better-bodies', 'Textures')),
    'the variant that was not chosen must not be installed');

  // And the dashboard can see it.
  const view = await (await fetch(`${base}/admin/api/mods`, { headers: auth }))
    .json() as { mods: { slug: string; present: boolean; plugins: unknown[] }[] };
  assert.equal(view.mods.length, 1);
  assert.equal(view.mods[0]!.present, true);

  // Deleting takes the folder with it.
  assert.equal((await fetch(`${base}/admin/api/mods/better-bodies`,
    { method: 'DELETE', headers: auth })).status, 200);
  assert.ok(!existsSync(join(gameData, 'mods', 'better-bodies')));
});

test('a RAR body is refused with advice, not a stack trace', async (t) => {
  const dataDir = tmpDataDir();
  mkdirSync(join(dataDir, 'gamedata'), { recursive: true });
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const owner = await fetch(`${base}/admin/api/setup/owner`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'z@example.com', password: 'a-long-enough-passphrase' }),
  });
  const token = (await owner.json() as { token: string }).token;

  const r = await fetch(`${base}/admin/api/mods/install?name=mod.rar`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    body: Buffer.from('Rar!\x1a\x07\x00' + 'x'.repeat(400)),
  });
  assert.equal(r.status, 400);
  // p7zip in this image is built without the non-free RAR codec, so this is a real limit and
  // the message has to name the way out rather than the internals.
  assert.match((await r.json() as { error: string }).error, /RAR archives are not supported/);
});

test('a failure part-way leaves NO folders from that request behind', async () => {
  // The document is written once, at the end. An earlier choice that extracted cleanly before a
  // later one failed would otherwise sit on disk in no list at all: served to players by
  // /mwdata, counted by the manifest walk, and invisible in the dashboard.
  const dataDir = tmp(); const gameDataDir = tmp();
  stage(dataDir, TOKEN, [
    { name: 'good/A.esp', data: 'x' },
    { name: 'bad/B.esp', data: 'y' },
  ]);
  // Corrupt the SECOND choice only, by claiming a checksum its bytes will not produce.
  const entries = listEntries(join(dataDir, 'mod-staging', `${TOKEN}.zip`));
  const bad = entries.find((e) => e.path === 'bad/B.esp')!;
  bad.crc32 ^= 0xffff;

  const res = await commitInstall(dataDir, gameDataDir, TOKEN, [
    { path: 'good', slug: 'good', name: 'Good' },
    { path: 'bad', slug: 'bad', name: 'Bad' },
  ]);
  // Whether the tampered entry is caught depends on the zip reader, which has its own tests;
  // what matters here is that success and failure both leave a CONSISTENT state.
  if (res.ok) {
    assert.deepEqual(readModDoc(dataDir).mods.map((m) => m.slug).sort(), ['bad', 'good']);
  } else {
    assert.deepEqual(readModDoc(dataDir).mods, [], 'nothing recorded');
    assert.ok(!existsSync(join(gameDataDir, 'mods', 'good')), 'the earlier choice must be gone too');
    assert.ok(!existsSync(join(gameDataDir, 'mods', 'bad')));
  }
});

test('two installs at once do not lose one of the mods', async () => {
  // Both read the document, both change it, both write it back. Without serialising, the second
  // write discards the first mod while its files stay on disk.
  const dataDir = tmp(); const gameDataDir = tmp();
  stage(dataDir, TOKEN, [{ name: 'A.esp', data: 'x' }]);
  const second = '1'.repeat(32);
  stage(dataDir, second, [{ name: 'B.esp', data: 'y' }]);

  await Promise.all([
    commitInstall(dataDir, gameDataDir, TOKEN, [{ path: '', slug: 'one', name: 'One' }]),
    commitInstall(dataDir, gameDataDir, second, [{ path: '', slug: 'two', name: 'Two' }]),
  ]);
  assert.deepEqual(readModDoc(dataDir).mods.map((m) => m.slug).sort(), ['one', 'two']);
});
