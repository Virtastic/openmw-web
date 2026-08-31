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
import { readFileSync } from 'node:fs';
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
