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

test('the recorded releases are real hashes of real archives', () => {
  // A table of made-up hashes is worse than an empty one: it never matches, and if it ever did
  // it would put the wrong version number on somebody's install. Every key here was taken from
  // an actual download with sha256sum.
  for (const [hash, label] of Object.entries(TR_RELEASES)) {
    assert.match(hash, /^[0-9a-f]{64}$/, `${label} has a key that is not a sha256`);
    assert.equal(hash, hash.toLowerCase());
  }
  // The three we have, hashed from the downloads themselves.
  assert.equal(
    identifyRelease('0613f33fabcc9285d821f52524ab4c2d2bece37dcdc1eb110ada772dd0ca73ef'),
    'Tamriel Rebuilt 26.08.23',
  );
  assert.equal(
    identifyRelease('009530c0383759b842298e827bf1ffd88e29b68668bbefe794bc376713e821cf'),
    'Tamriel Data 26.08',
  );
  assert.equal(
    identifyRelease('da5b37375434c265c47f484c4f005cf7e279bcaa1cccc39bf56c92d5bf8f5cda'),
    'Tamriel Data 26.08 (HD)',
  );
  // Two editions of one release are two files and must never collapse to one key.
  assert.equal(new Set(Object.keys(TR_RELEASES)).size, Object.keys(TR_RELEASES).length);
});

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

test('both halves of the download are recognised, which is not one naming scheme', () => {
  // The landmass ships TR_-prefixed plugins.
  assert.ok(looksLikeTamrielRebuilt(['00 Core/TR_Mainland.esm', 'readme.txt']));
  assert.ok(looksLikeTamrielRebuilt(['01 Faction Integration/Data Files/TR_Factions.esp']));
  // Tamriel Data does not: its plugin is Tamriel_Data.esm and its assets are LOOSE, so no TR_
  // prefix appears anywhere in the archive. Checked against the real 26.08 download, where the
  // first version of this told the operator their correct upload looked wrong.
  assert.ok(looksLikeTamrielRebuilt(['00 Data Files/Tamriel_Data.esm',
    '00 Data Files/meshes/tr/x/tr_flora.nif']));
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
  const steps = /return \[\r?\n\s+'owner',[\s\S]*?\];/.exec(app); // \r?: CRLF checkouts
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

test('the optional parts of the download are the operator to choose', () => {
  // THE REAL ARCHIVE SETTLED THIS. TR 26.08.23 ships three data folders: "00 Core" (the
  // landmass), "01 Faction Integration" and "02 Firemoth Remover" — and the last one removes a
  // vanilla quest island on purpose. The first version of this step installed every folder it
  // found, which would have applied that silently.
  const fn = /function wireTamriel\(\)[\s\S]*?\n\}/.exec(app)!;
  assert.ok(fn[0].includes('data-trcand="${i}"'), 'no per-part checkbox');
  // EVERYTHING ticked by default — Tamriel Data's second part is just normal maps, and an
  // unticked box there read as a warning — except a part named as a REMOVER, because the
  // landmass ships "02 Firemoth Remover" and auto-installing a mod that deletes a vanilla
  // quest island is the one default worse than confusion.
  assert.ok(fn[0].includes("/remover/i.test(c.path) ? '' : 'checked'"));
  // And the install must read the ticks rather than the whole list.
  assert.ok(fn[0].includes('.filter((c, i) => stage.querySelector(`[data-trcand="${i}"]`).checked)'));
  assert.ok(fn[0].includes("if (!picked.length) { toast('Tick at least one part to install.', 'err'); return; }"));
});

test('a running install reports progress, and both installers show the bar', () => {
  // The commit is one request that can take minutes on a big .7z, and a spinner that long
  // reads as frozen. The server counts 7z's own extraction percent (-bsp1) and the placing
  // loop per staged token; the page polls it into the phase card's existing bar.
  const sevenzip = readFileSync(join(process.cwd(), 'src', 'core', 'sevenzip.ts'), 'utf8');
  assert.ok(sevenzip.includes("'-bsp1'"), 'extraction must emit percent, not run silent');
  const install = readFileSync(join(process.cwd(), 'src', 'net', 'admin', 'mod-install.ts'), 'utf8');
  assert.ok(install.includes('const installProgress = new Map'), 'no progress record');
  // Deleted on every exit, or the map grows one dead entry per install forever.
  assert.equal(install.split('installProgress.delete(token);').length - 1, 3,
    'the failure path, the write-failure path and the success path must each clean up');
  const routes = readFileSync(join(process.cwd(), 'src', 'net', 'admin', 'routes.ts'), 'utf8');
  assert.ok(routes.includes("path === '/admin/api/mods/install/progress'"), 'no endpoint to poll');
  assert.ok(routes.includes("await gate(req, res, auth, 'owner', true)"),
    'polls for minutes must be budget-exempt like the uploads they accompany');
  // BOTH installers: the wizard step and the mods page each start the poll and stop it in a
  // finally, so an error cannot leave an interval repainting a dead panel.
  assert.ok(app.includes('function pollInstall(stage, token)'));
  assert.equal(app.split('pollInstall(stage, staged.token)').length - 1, 2);
  assert.equal(app.split('stopPoll();').length - 1, 2);
});

test('Back and Skip are held while an upload or install is in flight', () => {
  // Tamriel Data is minutes of spinner, and "Skip for now" sat there looking like the way
  // out. The install would finish server-side either way; the operator who clicked Skip has
  // just been taught, wrongly, that it did not.
  const fn = /function wireTamriel\(\)[\s\S]*?\n\}/.exec(app)!;
  assert.ok(fn[0].includes('const trNav = (on) =>'), 'no nav hold');
  assert.ok(fn[0].split('trNav(false);').length - 1 === 2, 'both the upload and the install must hold it');
  assert.ok(fn[0].includes("['#wzNext', '#wzBack']"), 'both buttons, not just Skip');
});

test('the missing assets half is caught by the master list, not by a name', () => {
  // TR_Mainland.esm declares Morrowind, Tribunal, Bloodmoon AND Tamriel_Data.esm as its
  // masters — read off the real file. So "the assets were never uploaded" is already an exact,
  // engine-defined fact, and the same line covers a missing expansion or an unticked part with
  // no extra code. A filename heuristic was the first attempt and it was both narrower and
  // wrong: it looked for TR_Data.bsa, which Tamriel Data does not ship.
  const step = /async function stepTamriel\(\)[\s\S]*?\n\}/.exec(app)!;
  assert.ok(step[0].includes('const lacking = mods?.missingMasters || [];'));
  assert.ok(step[0].includes('needs ${n.master}, which is not installed.'));
  assert.doesNotMatch(app, /isTamrielData/, 'the name heuristic must be gone, not shadowed');
  // And the drop zone it points at must be open, not folded behind a summary.
  assert.ok(step[0].includes("<details class=\"mb-2\" ${raw(lacking.length ? 'open' : '')}>"));
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
