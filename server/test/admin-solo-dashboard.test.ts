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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LockerSessionStore } from '../src/auth/identities';
import { createSysInfo } from '../src/net/admin/sysinfo';

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

test('an unavailable reading is omitted, never drawn as a confident zero', () => {
  const cards = /function sysCards\(sys\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(cards);
  assert.match(cards[0], /if \(!sys\) return '';/);
  assert.match(cards[0], /sys\.cpu\.percent !== null/);
  assert.match(cards[0], /if \(sys\.disk\)/);
  assert.match(cards[0], /if \(sys\.network\)/);
});
