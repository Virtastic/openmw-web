// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Which dropped folder shapes the uploader understands.

import test from 'node:test';
import assert from 'node:assert/strict';
import { safeUploadPath } from '../src/net/admin/api-mods';
import { startServer } from '../src/server';
import { tmpDataDir } from './helpers';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { crc32 } from '../src/core/zip';
import { join } from 'node:path';

test('the folder people actually drag is understood', () => {
  // The instruction says "drag Data Files". Half the time what gets dragged is the folder
  // above it, the one called Morrowind, which is what people think of as where the game
  // lives. Every one of these used to be refused, and the page called that normal.
  assert.equal(safeUploadPath('Morrowind/Data Files/Morrowind.esm'), 'Morrowind.esm');
  assert.equal(safeUploadPath('Morrowind/Data Files/Music/Explore/mx_explore_1.mp3'),
    'Music/Explore/mx_explore_1.mp3');
  // Steam nests it deeper still.
  assert.equal(safeUploadPath('common/Morrowind/Data Files/Sound/Fx/enghum.wav'),
    'Sound/Fx/enghum.wav');
  // Case varies by installer.
  assert.equal(safeUploadPath('Morrowind/DATA FILES/Bloodmoon.bsa'), 'Bloodmoon.bsa');

  // The plain cases still work: the picker naming the chosen folder, and no container.
  assert.equal(safeUploadPath('Data Files/Morrowind.esm'), 'Morrowind.esm');
  assert.equal(safeUploadPath('Morrowind.esm'), 'Morrowind.esm');
  assert.equal(safeUploadPath('Music/Explore/mx_explore_1.mp3'), 'Music/Explore/mx_explore_1.mp3');
});

test('anchoring on Data Files does not open a way out of the folder', () => {
  // Every segment after the anchor is still validated, and the final rule still demands a
  // core file at the root or a known media directory.
  for (const bad of [
    'Data Files/../../etc/passwd',
    'Data Files/../Morrowind.esm',
    'Morrowind/Data Files/nested/deep/Morrowind.esm', // core file must sit at the root
    'Data Files/Sound/../../escape.wav',
    'Data Files/.ssh/id_rsa',
    'Data Files/notes.txt',                            // not game data
    '/Data Files/Morrowind.esm',                        // absolute
    'C:/Data Files/Morrowind.esm',                       // drive-relative
  ]) {
    assert.equal(safeUploadPath(bad), null, `${bad} must be refused`);
  }
});

test('two uploads of one file do not fight over a temp path', async (t) => {
  // THE REPORTED BUG. The temp file was `${target}.${process.pid}.upload`, and in a container
  // the pid is always 1, so every upload of the same name shared one path. Two overlapping
  // requests for Morrowind.bsa — a retry begun while the first was still in flight, which on
  // a 300MB archive is a long window — wrote into the same file, then the first rename moved
  // it away and the second died with ENOENT. The small files in the same run all succeeded,
  // which is what made it look like large files specifically were broken.
  const dataDir = tmpDataDir();
  const gameData = join(dataDir, 'gamedata');
  mkdirSync(gameData, { recursive: true });
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const owner = await fetch(`${base}/admin/api/setup/owner`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'up@example.com', password: 'a-long-enough-passphrase' }),
  });
  const token = (await owner.json() as { token: string }).token;

  const put = (body: Buffer) => fetch(
    `${base}/admin/api/mods/upload?name=${encodeURIComponent('Morrowind.bsa')}`,
    { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body },
  );
  const results = await Promise.all([
    put(Buffer.alloc(4096, 1)), put(Buffer.alloc(4096, 2)),
    put(Buffer.alloc(4096, 3)), put(Buffer.alloc(4096, 4)),
  ]);
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200],
    'every writer finishes; none is left renaming a file another one already moved');

  // And one whole file survives, never a mix of two.
  const got = readFileSync(join(gameData, 'Morrowind.bsa'));
  assert.equal(got.length, 4096);
  assert.ok([1, 2, 3, 4].some((b) => got.equals(Buffer.alloc(4096, b))), 'the file is torn');
});

test('a bundle of small files lands each one, and skips what is not game data', async (t) => {
  // A Data Files folder is ten thousand voice clips; one request each made Chromium give up.
  // The dashboard packs them into stored zips, and each entry must get the same rules a
  // single upload gets: placed by path, refused when not game data, never outside the folder.
  const dataDir = tmpDataDir();
  const gameData = join(dataDir, 'gamedata');
  mkdirSync(gameData, { recursive: true });
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const owner = await fetch(`${base}/admin/api/setup/owner`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'up@example.com', password: 'a-long-enough-passphrase' }),
  });
  const token = (await owner.json() as { token: string }).token;

  const files: { name: string; data: Buffer }[] = [
    { name: 'Data Files/Sound/Cr/ashslv/moan.wav', data: Buffer.alloc(3000, 7) },
    { name: 'Data Files/Music/Explore/mx_explore_1.mp3', data: Buffer.from('mp3') },
    { name: 'Data Files/readme.txt', data: Buffer.from('not game data') },
  ];
  // Stored, as the browser builds it.
  const stored = (files: { name: string; data: Buffer }[]): Buffer => {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let off = 0;
    for (const f of files) {
      const name = Buffer.from(f.name);
      const crc = crc32(f.data);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
      lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(f.data.length, 18); lh.writeUInt32LE(f.data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
      ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(f.data.length, 20); ch.writeUInt32LE(f.data.length, 24);
      ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
      locals.push(lh, name, f.data);
      centrals.push(ch, name);
      off += 30 + name.length + f.data.length;
    }
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
    return Buffer.concat([...locals, cd, end]);
  };
  const post = (body: Buffer) => fetch(`${base}/admin/api/mods/upload-bundle`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    body,
  });

  const r = await post(stored(files));
  assert.equal(r.status, 200);
  const body = await r.json() as { added: string[]; skipped: string[]; failed: unknown[] };
  assert.deepEqual(body.added, [files[0]!.name, files[1]!.name]);
  assert.deepEqual(body.skipped, [files[2]!.name]);
  assert.ok(readFileSync(join(gameData, 'Sound/Cr/ashslv/moan.wav')).equals(files[0]!.data));
  assert.equal(readFileSync(join(gameData, 'Music/Explore/mx_explore_1.mp3'), 'utf8'), 'mp3');
  assert.deepEqual(readdirSync(join(dataDir, 'upload-parts')), [], 'the bundle is deleted after');

  // A path that climbs out refuses the whole bundle: no browser of ours builds one.
  const escape = await post(stored([{ name: 'Data Files/../../escape.wav', data: Buffer.from('no') }]));
  assert.equal(escape.status, 422);
  assert.ok(!existsSync(join(dataDir, 'escape.wav')));
  assert.equal((await post(Buffer.from('not a zip at all, not even close'))).status, 422);
});
