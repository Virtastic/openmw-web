// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Which dropped folder shapes the uploader understands.

import test from 'node:test';
import assert from 'node:assert/strict';
import { safeUploadPath } from '../src/net/admin/api-mods';

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
