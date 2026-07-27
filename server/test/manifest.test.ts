// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The content gate. Covers tier 1 (adopt-first, today's behaviour) and tier 2 (the server
// owns the world's data, so the canonical list is pinned and clients are measured against
// it rather than against whichever stranger connected first).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContentGate } from '../src/core/manifest';
import type { ManifestEntry } from '../src/proto/session';

// A REAL client's manifest, captured from ContentGate.check during s01. Fixtured verbatim
// because it is the evidence that the server cannot DERIVE this list: entries 0 and 1 come
// from the engine's resources, not from any game data folder. A future refactor that tries
// to rebuild it from a directory scan or an openmw.cfg will fail here, which is the point.
const REAL_CLIENT: ManifestEntry[] = [
  { name: 'builtin.omwscripts', size: 0, idx: 0 },
  { name: 'openmw-template.omwgame', size: 0, idx: 1 },
  { name: 'land.esp', size: 0, idx: 2 },
  { name: 'examplesuite.omwaddon', size: 0, idx: 3 },
  { name: 'mp.omwscripts', size: 0, idx: 4 },
];

const clone = (m: ManifestEntry[]): ManifestEntry[] => m.map((e) => ({ ...e }));

const without = (m: ManifestEntry[], name: string): ManifestEntry[] =>
  clone(m).filter((e) => e.name !== name).map((e, i) => ({ ...e, idx: i }));

const plus = (m: ManifestEntry[], name: string): ManifestEntry[] =>
  [...clone(m), { name, size: 0, idx: m.length }];

test('tier 1: the first client defines the session, and an empty server forgets it', () => {
  const gate = new ContentGate('names');
  assert.equal(gate.isAuthoritative, false);
  assert.deepEqual(gate.check(REAL_CLIENT), { ok: true }, 'first client is adopted');

  const other = without(REAL_CLIENT, 'land.esp');
  assert.equal(gate.check(other).ok, false, 'a differing second client is refused');

  gate.release(); // the adopted client leaves; holders -> 0
  assert.deepEqual(gate.check(other), { ok: true },
    'with the server empty, the next player re-canonicalizes (tier 1 self-heals)');
});

test('tier 2: the pinned list survives an empty server', () => {
  const gate = new ContentGate('names');
  gate.setAuthoritative(REAL_CLIENT);
  assert.equal(gate.isAuthoritative, true);

  assert.deepEqual(gate.check(REAL_CLIENT), { ok: true });
  gate.release(); // everyone leaves

  const other = without(REAL_CLIENT, 'land.esp');
  assert.equal(gate.check(other).ok, false,
    'an authoritative list belongs to the WORLD — an empty server must not forget it');
});

test('tier 2: a refusal names the file, not a position', () => {
  const gate = new ContentGate('names');
  gate.setAuthoritative(REAL_CLIENT);

  const r = gate.check(without(REAL_CLIENT, 'examplesuite.omwaddon'));
  assert.equal(r.ok, false);
  const detail = (r as { ok: false; detail: string }).detail;
  assert.match(detail, /examplesuite\.omwaddon/,
    `the player must be told WHICH file is missing; got: ${detail}`);
  assert.doesNotMatch(detail, /position \d/,
    'a raw position is not actionable for a player');
});

test('tier 2: extra content is named too', () => {
  const gate = new ContentGate('names');
  gate.setAuthoritative(REAL_CLIENT);

  const r = gate.check(plus(REAL_CLIENT, 'SuperSword.esp'));
  assert.equal(r.ok, false);
  assert.match((r as { ok: false; detail: string }).detail, /SuperSword\.esp/);
});

test('size is skipped when either side reports 0, and compared when both are real', () => {
  // Clients ALWAYS send size 0 (Lua cannot read file sizes). If the server ever records real
  // sizes, comparing them against 0 would refuse every client — so 0 means "unverifiable".
  const serverSide = REAL_CLIENT.map((e) => ({ ...e, size: 12345 }));
  const gate = new ContentGate('names');
  gate.setAuthoritative(serverSide);
  assert.deepEqual(gate.check(REAL_CLIENT), { ok: true },
    'a client reporting size 0 must not be refused by a server that knows real sizes');

  // But two REAL differing sizes are a genuine mismatch and must still fail.
  const gate2 = new ContentGate('names');
  gate2.setAuthoritative(serverSide);
  const differing = REAL_CLIENT.map((e) => ({ ...e, size: 999 }));
  assert.equal(gate2.check(differing).ok, false,
    'the skip is 0-only, not a blanket "ignore size"');
});

test('reordering the same files is refused, and says so in load-order terms', () => {
  const gate = new ContentGate('names');
  gate.setAuthoritative(REAL_CLIENT);

  const swapped = clone(REAL_CLIENT);
  [swapped[2]!.name, swapped[3]!.name] = [swapped[3]!.name, swapped[2]!.name];
  const r = gate.check(swapped);
  assert.equal(r.ok, false, 'same files in a different order is still a mismatch');
  assert.match((r as { ok: false; detail: string }).detail, /load order/i);
});

test("mode 'off' ignores everything, including an authoritative list", () => {
  const gate = new ContentGate('off');
  gate.setAuthoritative(REAL_CLIENT);
  assert.deepEqual(gate.check(plus(without(REAL_CLIENT, 'land.esp'), 'Whatever.esp')), { ok: true },
    'off means off — it must short-circuit before the authoritative path');
});
