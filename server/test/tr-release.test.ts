// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Identifying a Tamriel Rebuilt release by the bytes of its archive.
//
// The whole reason this exists: no TR file is checked by name anywhere, because release names
// vary and browsers, chat clients and mod managers rename downloads on the way through. The
// archive's sha256 does not vary. What must NOT happen is a stale table turning into a
// refusal — TR ships releases on its own schedule, so "not in the list" has to stay an
// ordinary answer that installs anyway.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';

import { TR_RELEASES, identifyRelease, looksLikeTamrielRebuilt } from '../src/core/tr-releases';
import { streamToFile } from '../src/net/admin/mod-install';
import { tmpDataDir } from './helpers';

const HASH = 'a'.repeat(64);

test('a release nobody recorded is unnamed, not rejected', () => {
  // null is the answer the wizard renders as "not in our list yet, installing anyway". An
  // exception, or a false, would have to be handled at the call site as a failure.
  assert.equal(identifyRelease('b'.repeat(64)), null);
  assert.equal(identifyRelease(''), null);
});

test('a recorded hash gives its version back, however it is cased', () => {
  TR_RELEASES[HASH] = 'Tamriel Rebuilt 99.9';
  try {
    assert.equal(identifyRelease(HASH), 'Tamriel Rebuilt 99.9');
    // sha256sum, shasum and the dashboard all print it differently.
    assert.equal(identifyRelease(HASH.toUpperCase()), 'Tamriel Rebuilt 99.9');
    assert.equal(identifyRelease(`  ${HASH}\n`), 'Tamriel Rebuilt 99.9');
  } finally {
    delete TR_RELEASES[HASH];
  }
});

test('TR is recognised by its own files, at any depth in the archive', () => {
  assert.ok(looksLikeTamrielRebuilt(['TR_Data.bsa']));
  assert.ok(looksLikeTamrielRebuilt(['00 Core/TR_Mainland.esm', 'readme.txt']));
  assert.ok(looksLikeTamrielRebuilt(['Tamriel_Data/TR_Factions.esp']));
});

test('and is not claimed by an archive that merely mentions it', () => {
  // The check gates a warning, so a false positive is the expensive direction: it would tell
  // an operator the wrong download was right.
  assert.equal(looksLikeTamrielRebuilt(['Morrowind.esm', 'Music/mx_explore_1.mp3']), false);
  // A mesh whose name happens to start TR_ is not a plugin or an archive.
  assert.equal(looksLikeTamrielRebuilt(['Meshes/tr_rock_01.nif']), false);
  // The prefix must start a filename, not appear inside one.
  assert.equal(looksLikeTamrielRebuilt(['Better_TR_patch_notes.esp']), false);
  assert.equal(looksLikeTamrielRebuilt([]), false);
});

test('the hash comes from the bytes that were actually written', async () => {
  // Taken from the chunks on the way past rather than by re-reading a multi-gigabyte file, so
  // the thing worth pinning is that the shortcut still agrees with hashing the result.
  const dataDir = tmpDataDir();
  const target = join(dataDir, 'staged.zip');
  const chunks = [randomBytes(1000), randomBytes(64_000), randomBytes(37)];

  const got = await streamToFile(
    Readable.from(chunks) as unknown as IncomingMessage, target, 10 * 1024 * 1024,
  );
  assert.ok(got.ok);
  assert.equal(got.bytes, 1000 + 64_000 + 37);
  assert.equal(got.sha256, createHash('sha256').update(readFileSync(target)).digest('hex'));
});

// --- the wizard step ---------------------------------------------------------------------
//
// Static assertions against the dashboard source: it is browser code with no module boundary
// to import, and these are facts about which screens exist rather than about rendering.

const app = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8');

test('the Tamriel step is asked only of the profile that needs it, and after the game data', () => {
  assert.ok(app.includes("...(answers.contentProfile === 'tamriel-rebuilt' ? ['tr'] : [])"),
    'the TR step must be conditional on the profile');
  const steps = /return \[\n\s+'owner',[\s\S]*?\];/.exec(app);
  assert.ok(steps, 'wizard step list not found');
  // Order is the point: TR is a second upload, and asking for it before the base game is in
  // would put the expansion before the thing it expands.
  assert.ok(steps[0].indexOf("'files'") < steps[0].indexOf("'tr'"));
  assert.ok(steps[0].indexOf("'tr'") < steps[0].indexOf("'review'"));
});

test('an unrecognised release still gets an Install button', () => {
  // The regression this guards is a wizard that refuses everything newer than its own table.
  const fn = /function wireTamriel\(\)[\s\S]*?\n\}/.exec(app);
  assert.ok(fn, 'wireTamriel not found');
  assert.ok(fn[0].includes('not in our list yet'), 'the unknown-release wording is missing');
  // One Install button, rendered outside every release/looks-like branch.
  assert.equal(fn[0].split("id=\"trGo\"").length - 1, 1);
  const marker = fn[0].indexOf("id=\"trGo\"");
  const unknown = fn[0].indexOf('not in our list yet');
  assert.ok(unknown < marker, 'the button must come after, and outside, the warning');
});

test('the review says so when the profile was chosen and TR never arrived', () => {
  // The file checklist cannot catch this: it checks no TR file by name, so a plain Morrowind
  // folder shows a full column of ticks under the Tamriel Rebuilt profile.
  assert.ok(app.includes('Tamriel Rebuilt is not installed.'));
  assert.ok(app.includes('tamrielMissing = found.length === 0;'));
});

test('"back a step" from the review goes to a named step, not step minus one', () => {
  // Inserting the TR step between Data and Review moved what step-1 meant.
  assert.ok(app.includes("back.onclick = goTo('files')"));
  assert.ok(app.includes("backTr.onclick = goTo('tr')"));
});
