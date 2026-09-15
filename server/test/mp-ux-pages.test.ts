// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// STATIC CHECKS ON THE TWO PAGES for the MP UX rows that live in page JS (#88, #89). The
// pages are not driven headlessly here (pagescope.test.ts proves they resolve); these pin
// the wiring so the fix cannot be edited away in silence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PLAY = join(import.meta.dirname, '..', '..', 'play');
// The tier2 image carries no play/ (authticket/play-front-door skip the same way).
const pages = existsSync(join(PLAY, 'index.html')) && existsSync(join(PLAY, 'launcher.html'));
const opts = pages ? {} : { skip: 'play/ pages are not part of the server image' };
const index = pages ? readFileSync(join(PLAY, 'index.html'), 'utf8') : '';
const launcher = pages ? readFileSync(join(PLAY, 'launcher.html'), 'utf8') : '';

test('#88: BAD_CONTENT reloads once automatically, then shows the remedy and a Reload button', opts, () => {
  assert.ok(index.includes('BAD_CONTENT_REMEDY = \'The world’s mod list changed since this page loaded'), 'no remedy sentence');
  // The auto-reload is guarded by sessionStorage and cleared once a join succeeds.
  assert.ok(index.includes("sessionStorage.getItem(BAD_CONTENT_RELOADED) === '1'"), 'no loop guard');
  assert.ok(index.includes("sessionStorage.setItem(BAD_CONTENT_RELOADED, '1')"), 'guard never set');
  assert.ok(index.includes("if (s === 'Joined') { try { sessionStorage.removeItem(BAD_CONTENT_RELOADED); }"), 'guard never cleared');
  // The modal path passes the remedy and asks for the Reload button.
  assert.ok(index.includes("mpErrorModal('Can’t join multiplayer', msg + ' ' + BAD_CONTENT_REMEDY, { reload: true })"));
  assert.ok(index.includes("rl.textContent = 'Reload';"), 'no Reload button');
  // The auto-reload path never reaches the modal.
  const auto = index.indexOf("console.log('[mp] BAD_CONTENT — reloading once");
  assert.ok(auto > 0);
  assert.ok(index.slice(auto, auto + 400).includes('location.reload();'));
});

test('#89: a friend playing solo is listed as such, with no join button', opts, () => {
  assert.ok(launcher.includes("const solo = f.mode === 'private';"));
  assert.ok(launcher.includes("'<b></b> is playing solo'"));
  assert.ok(launcher.includes('if (solo) { wrap.appendChild(row); return; }'), 'a solo row still gets a Join button');
  // The join-as hint is joinable rows only.
  assert.ok(launcher.includes('if (ready[0] && !solo) {'));
});
