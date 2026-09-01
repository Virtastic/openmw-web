// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The front door hands the game page a mode, and it must be the mode the operator chose.
//
// index.html decides a session is multiplayer from `mp=` being present in the fragment and
// nothing else ("index.html keys multiplayer off mp= alone, so omitting it is the whole
// mode", launcher.html). play.js sent `mp=` unconditionally, so a server the wizard had
// configured as single player booted the engine into multiplayer: the page titled itself
// MULTIPLAYER and tried to join a world that, in that mode, nothing simulates.
//
// Static assertions because play.js is browser code with no module boundary to import: it
// runs inside an async IIFE against a live DOM. What is worth pinning here is the shape of
// the two fragments and the fact that the branch exists at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const play = readFileSync(join(process.cwd(), 'web', 'play.js'), 'utf8');

test('the front door reads the deployment mode the wizard stored', () => {
  assert.match(play, /deploymentMode/,
    'play.js must consult the wizard answer, not assume a mode');
});

test('single player boots WITHOUT mp=, which is what makes it single player', () => {
  // The branch must produce a cloud-locker fragment: the locker origin, and cloud=1 for
  // index.html's own launcher gate. Crucially no mp=.
  const branch = /if \(singlePlayer\) \{[\s\S]*?\n    \}/.exec(play);
  assert.ok(branch, 'no single-player branch in enterGame');
  assert.match(branch[0], /#locker=/);
  assert.match(branch[0], /cloud=1/);
  assert.doesNotMatch(branch[0], /[#&]mp=/,
    'sending mp= is exactly the bug: it turns single player into multiplayer');
});

test('multiplayer still gets mp= and a ticket', () => {
  // The other half of the branch must keep working; a fix that disabled multiplayer instead
  // of routing around it would pass the test above and be just as broken.
  assert.match(play, /#mp=\$\{encodeURIComponent\(ws\)\}/);
  assert.match(play, /mpticket=\$\{encodeURIComponent\(res\.ticket\)\}/);
});

test('an unreadable state defaults to single player, the mode that needs no world', () => {
  // Guessing multiplayer would mean dialling a world that may not be simulating anything.
  assert.match(play, /let singlePlayer = true;/);
});

// --- the credential must not be left in the address bar ------------------------------------
//
// The fragment is the right way to CARRY a token: it is never sent to the server, never
// logged, never in a Referer. None of that argues for leaving it on screen afterwards. The
// multiplayer branch has always erased it; the cloud-locker boot never reached that code,
// because the scrub is gated on an mpticket and this door has no mp= at all. A 24h bearer for
// every /locker/* route — erase included — stayed in the address bar, in history, and in
// whatever profile sync copies history to.

// The player app lives outside the server package and is NOT copied into the server image, so
// in the container test gate there is nothing to read. Skipping is the honest answer there:
// these assert facts about the client, and the client is not part of that build. They still run
// in a checkout, which is where the file is edited.
const indexPath = join(process.cwd(), '..', 'play', 'index.html');
const index = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
const clientOpts = index === ''
  ? { skip: 'play/index.html is not part of the server image' }
  : {};

test('the cloud-locker boot erases its own fragment', clientOpts, () => {
  const scrub = /if \(\/\[#&\]cloud=1\\b\/\.test\(location\.hash \|\| ''\)\) \{[\s\S]*?\n       \}/.exec(index);
  assert.ok(scrub, 'no cloud-fragment scrub; the locker token stays in the URL');
  assert.match(scrub[0], /history\.replaceState\(null, '', location\.pathname \+ location\.search\)/);
});

test('and does not keep the live token in the fragment it stashes', clientOpts, () => {
  const scrub = /if \(\/\[#&\]cloud=1\\b\/\.test\(location\.hash \|\| ''\)\) \{[\s\S]*?\n       \}/.exec(index)!;
  // __omwBootFrag outlives the scrub, so copying mplocker into it would move the credential
  // rather than remove it.
  assert.match(scrub[0], /mplocker/, 'the stash must explicitly drop mplocker');
  assert.match(scrub[0], /filter\(/);
});

test('the multiplayer scrub is still in place', clientOpts, () => {
  // Both doors, not one: fixing the cloud path by disturbing the MP path would be a trade.
  assert.match(index, /window\.__omwBootFrag = String\(location\.hash \|\| ''\)\.replace\(\/\^#\/, ''\);/);
});

// --- the browser loading the operator's mods ---------------------------------------------------
//
// OpenMW is unforgiving here in a way that is worth stating: registerArchives() THROWS on a
// fallback-archive= it cannot resolve, and content loading aborts on a missing content=. Either
// one reaches the player as a black screen with no message. So every name the client emits has
// to be a name it watched itself mount.

test('mods come from the server list, not from guessing at file names', clientOpts, () => {
  // buildLoadOrder only ever sees the TOP level of /mwdata, so a mod in its own folder would
  // mount and contribute nothing at all. The server knows which plugin belongs to which mod.
  assert.match(index, /async function mountServerMods\(\)/);
  assert.match(index, /fetch\('mwdata-mods\.json'\)/);
});

test('a mod whose plugin did not arrive is dropped whole, not half-loaded', clientOpts, () => {
  const fn = /async function mountServerMods\(\)\{[\s\S]*?\n       \}/.exec(index);
  assert.ok(fn, 'mountServerMods not found');
  assert.match(fn[0], /did not arrive/);
  // The drop must happen BEFORE anything is pushed into the emitted lists.
  assert.ok(fn[0].indexOf('continue;') < fn[0].indexOf('out.dirs.push(root)'));
});

test('no mods, or an unreadable list, is an ordinary answer', clientOpts, () => {
  // 404 means this server has no mods. It must never be a reason to refuse the game.
  const fn = /async function mountServerMods\(\)\{[\s\S]*?\n       \}/.exec(index)!;
  assert.match(fn[0], /if \(!r\.ok\) return out;/);
  assert.match(fn[0], /catch \(e\) \{ return out; \}/);
});

test('two mods shipping one archive name are renamed apart on mount', clientOpts, () => {
  // Collections::getPath resolves a bare archive name with rbegin, so the last data= dir wins
  // and one of them would silently vanish. We own the filesystem path, and only openmw.cfg
  // refers to a BSA by name, so renaming on the way in costs nothing and removes the ambiguity.
  const fn = /async function mountServerMods\(\)\{[\s\S]*?\n       \}/.exec(index)!;
  assert.match(fn[0], /claimed\[/);
  assert.match(fn[0], /mod\.slug \+ '-' \+ base/);
});

test('mod data= lines come after the asset pack so a mod wins', clientOpts, () => {
  // The pack is a general-purpose optimisation; a mod the operator installed on purpose
  // should beat it. It used to be last among archives outright.
  const i = index.indexOf("if (window.__assetPack) cfg.push('data=/mods'");
  const j = index.indexOf("mods.dirs.forEach");
  assert.ok(i > 0 && j > i, 'mod dirs must be emitted after the asset pack');
});

test('a renamed archive is still emitted, under its new name', clientOpts, () => {
  // The rename existed to stop two mods' identically-named .bsa files collapsing into one.
  // `mounted` was keyed by the name we KEPT while archives were looked up by the name the
  // server declared, so the renamed one missed and was dropped — the exact outcome the rename
  // was there to prevent, and invisible because the first mod's archive still worked.
  const fn = /async function mountServerMods\(\)\{[\s\S]*?\n       \}/.exec(index)!;
  assert.match(fn[0], /mounted\[f\.p\.toLowerCase\(\)\] = keep;/,
    'the lookup key must be what the server declared, not what we renamed it to');
});

// --- game data must not be re-downloaded every boot --------------------------------------------
//
// StreamFS chunks lived only in an in-memory LRU, so every session re-fetched every byte the
// engine touched (~300MB on a Balmora boot). Chunks now persist in the Cache API, keyed by the
// ORIGINAL mount URL and file size — stable across presigned-URL renewals, invalidated when a
// file is replaced with one of a different size.

const sfsPath = join(process.cwd(), '..', 'play', 'streamfs.js');
const sfs = existsSync(sfsPath) ? readFileSync(sfsPath, 'utf8') : '';
const sfsOpts = sfs === '' ? { skip: 'play/streamfs.js is not part of the server image' } : {};

test('fetched chunks persist in the Cache API', sfsOpts, () => {
  assert.ok(sfs.includes("caches.open('mwdata-chunks-v1')"), 'no persistent chunk cache');
  assert.ok(sfs.includes('.match(ckey)'), 'chunks are written but never read back');
});

test('the persistent key survives presigned-URL renewal and rejects expiring URLs', sfsOpts, () => {
  // Keyed by pathname+size, not the full URL: a locker URL is re-signed hourly and would never
  // hit twice, so query-carrying and cross-origin URLs must opt out entirely.
  assert.ok(sfs.includes("u.origin === location.origin && !u.search"), 'presigned URLs must not persist');
  assert.ok(sfs.includes("u.pathname + '@' + size + '@' + CHUNK"), 'the key must be pathname, size, and chunk granularity');
});
