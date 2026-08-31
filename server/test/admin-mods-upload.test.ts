// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Which dropped folder shapes the uploader understands.

import test from 'node:test';
import assert from 'node:assert/strict';
import { safeUploadPath } from '../src/net/admin/api-mods';
import { startServer } from '../src/server';
import { tmpDataDir } from './helpers';
import { mkdirSync, readFileSync } from 'node:fs';
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
