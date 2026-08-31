// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The single-player dashboard, and the two things it needed that did not exist.
//
// "In the world" counted the WS roster, which is right for multiplayer and structurally
// always zero for single player: the browser runs the engine and never joins anything. So an
// operator playing their own server was shown 0 players while playing. And the machine's own
// health had no reading at all, on the page that exists to say what the server is doing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LockerSessionStore } from '../src/auth/identities';
import { createSysInfo } from '../src/net/admin/sysinfo';
import { MULTIPLAYER_ONLY, SECTION_GROUPS, settingsView } from '../src/net/admin/api-settings';

const app = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8');

// --- who is playing ------------------------------------------------------------------------

test('using the locker marks the account as playing', () => {
  const s = new LockerSessionStore();
  const token = s.mint('michael');
  assert.deepEqual(s.activeSince(60_000), [], 'minting a token is not playing');
  assert.equal(s.resolve(token), 'michael');
  assert.deepEqual(s.activeSince(60_000).map((a) => a.account), ['michael']);
});

test('activity ages out, so a closed tab stops counting', () => {
  // The whole point of a liveness signal over a session: a 24h token must not mean 24h of
  // being shown as in-game.
  const s = new LockerSessionStore();
  s.resolve(s.mint('michael'));
  assert.equal(s.activeSince(60_000).length, 1);
  assert.equal(s.activeSince(0).length, 0, 'a zero window can match nothing');
});

test('a bad token marks nobody', () => {
  const s = new LockerSessionStore();
  assert.equal(s.resolve('not-a-token'), undefined);
  assert.deepEqual(s.activeSince(60_000), []);
});

test('several accounts are listed most recently active first', async () => {
  const s = new LockerSessionStore();
  const a = s.mint('alice');
  const b = s.mint('bob');
  s.resolve(a);
  await new Promise((r) => setTimeout(r, 5));
  s.resolve(b);
  assert.deepEqual(s.activeSince(60_000).map((x) => x.account), ['bob', 'alice']);
});

// --- machine health ------------------------------------------------------------------------

test('system readings are real numbers, and rates need two samples', async () => {
  const read = createSysInfo(process.cwd());
  const first = await read();

  // Memory and core count are absolute readings, available immediately.
  assert.ok(first.memory.totalBytes > 0, 'no memory total');
  assert.ok(first.memory.usedBytes > 0 && first.memory.usedBytes <= first.memory.totalBytes);
  assert.ok(first.memory.percent >= 0 && first.memory.percent <= 100);
  assert.ok(first.cpu.cores > 0);

  // CPU is a counter difference, so the FIRST call has nothing to difference against and must
  // say so rather than reporting a made-up 0%.
  assert.equal(first.cpu.percent, null, 'first sample cannot know a rate');

  const second = await read();
  assert.ok(second.cpu.percent === null || (second.cpu.percent >= 0 && second.cpu.percent <= 100));

  // The data directory always exists here, so disk must resolve.
  assert.ok(second.disk, 'no disk reading for a path that exists');
  assert.ok(second.disk!.totalBytes > 0 && second.disk!.freeBytes >= 0);
});

// --- the page ------------------------------------------------------------------------------

test('the single-player dashboard drops the multiplayer furniture', () => {
  const solo = /if \(solo\) \{[\s\S]*?\n    return;\n  \}/.exec(app);
  assert.ok(solo, 'no single-player branch on the overview');
  assert.doesNotMatch(solo[0], /setupChecklist\(\)/, 'the getting-started widget must be gone');
  assert.doesNotMatch(solo[0], /'World'/, 'the world card names an id nobody chose');
  assert.doesNotMatch(solo[0], /maxPlayers/, 'a player cap is meaningless here');
  // And keeps what a solo operator actually wants.
  assert.match(solo[0], /Playing now/);
  assert.match(solo[0], /sysCards\(o\.system\)/);
});

test('multiplayer keeps its own dashboard', () => {
  // The fix must not be "delete the multiplayer view".
  assert.match(app, /stat\(`Players \(of \$\{o\.maxPlayers\}\)`/);
  assert.match(app, /stat\('World', o\.world\.id/);
});

// --- settings that need a world, or a second person ------------------------------------------

test('the sections a lone player cannot use are named', () => {
  // Each of these is read by the server's own world simulation, by a join handshake, or by
  // there being somebody else. None of the three happens in single player.
  for (const s of ['rules', 'economy', 'time', 'gui', 'cellReset', 'sharing', 'moderation',
    'authority', 'content', 'engine', 'simPeer', 'gateway', 'worlds']) {
    assert.ok(MULTIPLAYER_ONLY.includes(s), `${s} should be hidden in single player`);
  }
});

test('sections that still do part of their job are NOT hidden', () => {
  // The cut is "does nothing here", not "sounds multiplayer-ish". [admin] holds the
  // dashboard's own owners and token, [limits] still rate-limits sign-in, [locker] is how the
  // one player gets their files, [login]/[auth] are how they sign in.
  for (const s of ['server', 'login', 'auth', 'admin', 'limits', 'locker', 'metrics',
    'notifications', 'integrations', 'dev']) {
    assert.ok(!MULTIPLAYER_ONLY.includes(s), `${s} still matters in single player`);
  }
});

test('every hidden name is a real section, not a typo', () => {
  // A misspelling here hides nothing and is invisible: the page just keeps showing it.
  const known = new Set([...SECTION_GROUPS.flatMap((g) => g.sections), 'engine']);
  assert.deepEqual(MULTIPLAYER_ONLY.filter((s) => !known.has(s)), []);
});

test('the list ships with the settings payload', () => {
  const view = settingsView(mkdtempSync(join(tmpdir(), 'set-')), {
    server: { name: 'x' }, rules: { pvp: true },
  });
  assert.deepEqual(view.multiplayerOnly, MULTIPLAYER_ONLY);
});

test('the page filters by it and drops groups left empty', () => {
  // "Platform (advanced)" is simPeer/gateway/worlds and nothing else, so in single player it
  // must go entirely rather than remain as a heading that opens onto nothing.
  assert.match(app, /const hide = singlePlayer\(\) \? new Set\(settingsCache\.multiplayerOnly \|\| \[\]\) : new Set\(\);/);
  assert.match(app, /\.filter\(\(g\) => g\.sections\.length\)/);
  const platform = SECTION_GROUPS.find((g) => g.group.startsWith('Platform'))!;
  assert.deepEqual(platform.sections.filter((s) => !MULTIPLAYER_ONLY.includes(s)), [],
    'the whole Platform group must be hidden, or the group survives with a gap in it');
});

// --- pages that cannot work in a one-person deployment ---------------------------------------

test('Players & commands is marked unavailable in single player', () => {
  // Every control on it acts on a player connected to a world. In single player the browser
  // runs the engine and never connects, so there is nobody to broadcast to or hand an item.
  assert.match(app, /hash: '#console'[^}]*solo: false/);
});

test('the sidebar filters those pages out', () => {
  assert.match(app, /i\.solo === false && singlePlayer\(\)/);
});

test('and the hash is closed too, not merely unlinked', () => {
  // A hidden link is still a working URL when typed, bookmarked, or followed from an older
  // link, which would land on a console whose every button acts on an empty world.
  const guard = /if \(singlePlayer\(\) && NAV\.some[\s\S]*?\n  \}/.exec(app);
  assert.ok(guard, 'no route guard for solo-hidden pages');
  assert.match(guard[0], /go\('#overview'\)/);
});

test('multiplayer still reaches the console', () => {
  assert.match(app, /'#console': pageConsole/);
});

// --- the row of cards ----------------------------------------------------------------------

const css = readFileSync(join(process.cwd(), 'web', 'app.css'), 'utf8');

test('stat cards fill their column, so a row of them cannot go ragged', () => {
  // Only some cards carry a second line. The columns always stretched to the tallest; the
  // boxes inside them did not, so the shorter cards floated with a gap beneath.
  assert.match(css, /\.row > \[class\*="col-"\] > \.small-box \{[^}]*height: 100%/);
  assert.match(css, /\.small-box > \.small-box-footer \{ margin-top: auto; \}/);
});

test('the margin is on the column, not on a box that now fills it', () => {
  // A margin on a height:100% box overflows its column and brings the ragged row back.
  assert.doesNotMatch(app, /<div class="small-box text-bg-\$\{raw\(tone\)\} mb-3">/);
  assert.match(app, /<div class="col-6 col-lg-3 mb-3">/);
});

test('every text-bg-* tone is neutralised, not a hand-kept list of four', () => {
  // The list did not cover text-bg-info, so the first card to use it returned in Bootstrap
  // cyan on a palette built to keep exactly that out.
  assert.match(css, /\.small-box\[class\*="text-bg-"\] \{/);
});

test('an unavailable reading is omitted, never drawn as a confident zero', () => {
  const cards = /function sysCards\(sys\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(cards);
  assert.match(cards[0], /if \(!sys\) return '';/);
  assert.match(cards[0], /sys\.cpu\.percent !== null/);
  assert.match(cards[0], /if \(sys\.disk\)/);
  assert.match(cards[0], /if \(sys\.network\)/);
});
