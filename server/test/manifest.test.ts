// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The content gate. Covers tier 1 (adopt-first, today's behaviour) and tier 2 (the server
// owns the world's data, so the canonical list is pinned and clients are measured against
// it rather than against whichever stranger connected first).
import test from 'node:test';
// The peer's only credential; an empty [server].password refuses every system connection.
const PEER_PASS = 'peer-secret-1';
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

// End-to-end: the world's content list comes from the SIM PEER, not from the first human.
// This is the behaviour change — before it, whichever stranger connected first defined what
// everyone else had to match.
test('e2e: the sim peer pins the world content list and mismatched players are refused', async () => {
  const { startServer } = await import('../src/server');
  const { TestClient, tmpDataDir, MANIFEST } = await import('./helpers');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');

  // Tier 2 requires VALID game data on the server, otherwise the peer's manifest is not
  // trusted (a server with no data has no business dictating content).
  const dir = tmpDataDir();
  const gd = join(dir, 'gamedata');
  mkdirSync(gd, { recursive: true });
  for (const f of ['Morrowind.esm', 'Morrowind.bsa']) writeFileSync(join(gd, f), 'x');

  const server = await startServer({ requireGameData: false, configOverride: { server: { password: PEER_PASS } }, dataDir: dir, port: 0, host: '127.0.0.1' });
  try {
    // The peer connects first and declares the world's content.
    const peer = await TestClient.connect(server.port);
    peer.system = true;
    peer.serverPassword = PEER_PASS;
    await peer.joinAsNew('simpeer_world');

    // A player with the SAME content joins normally.
    const ok = await TestClient.connect(server.port);
    const welcome = await ok.joinAsNew('matching_player');
    assert.ok(welcome.playerId > 0, 'a matching player joins');

    // A player MISSING a file is refused, and told which one.
    const bad = await TestClient.connect(server.port);
    bad.hello(MANIFEST.filter((e) => e.name !== 'mp.omwscripts'));
    const refusal = await bad.waitJson('SessionDisconnect');
    assert.equal(refusal['code'], 'BAD_CONTENT');
    assert.match(String(refusal['detail']), /mp\.omwscripts/,
      'the refusal must name the file the player is missing');

    // THE DISTINGUISHING CHECK. Everything above would also pass under plain adopt-first
    // (the peer connected first, so its list would have been adopted anyway). What only
    // AUTHORITATIVE mode gives is that the list belongs to the WORLD: empty the server
    // completely, and a mismatched player is still refused instead of redefining the world.
    peer.ws.close();
    ok.ws.close();
    bad.ws.close();
    await new Promise((r) => setTimeout(r, 300)); // let the closes land, holders -> 0

    const late = await TestClient.connect(server.port);
    late.hello(MANIFEST.filter((e) => e.name !== 'mp.omwscripts'));
    const stillRefused = await late.waitJson('SessionDisconnect');
    assert.equal(stillRefused['code'], 'BAD_CONTENT',
      'on an EMPTY server the world still dictates its content — this is the whole point, '
      + 'and it is the one assertion adopt-first cannot satisfy');
    late.ws.close();
  } finally {
    await server.close();
  }
});

// ---- strict mode: per-file hashes ------------------------------------------------------
// names-and-order stops a player ADDING or REMOVING a file. It cannot stop one who edits
// Morrowind.esm in place to buff an item — same name, same index. That is what strict closes.

const hashed = (m: ManifestEntry[], overrides: Record<string, string> = {}): ManifestEntry[] =>
  m.map((e) => ({ ...e, sha256: overrides[e.name] ?? `hash-of-${e.name}` }));

test('strict: a TAMPERED file is refused and named, where names mode lets it through', () => {
  const world = hashed(REAL_CLIENT);
  const tampered = hashed(REAL_CLIENT, { 'land.esp': 'edited-by-a-cheater' });

  // The whole point: identical names, identical order — names mode cannot tell them apart.
  const lenient = new ContentGate('names');
  lenient.setAuthoritative(world);
  assert.deepEqual(lenient.check(tampered), { ok: true },
    'names mode is blind to an edited file — this is the hole strict exists to close');

  const strict = new ContentGate('strict');
  strict.setAuthoritative(world);
  const r = strict.check(tampered);
  assert.equal(r.ok, false);
  const detail = (r as { ok: false; detail: string }).detail;
  assert.match(detail, /land\.esp/, 'the refusal names the file');
  assert.doesNotMatch(detail, /edited-by-a-cheater|hash-of-/,
    'never show raw hashes — they tell a player nothing actionable');
});

test('strict: a client that reports NO hashes is refused; names mode still accepts it', () => {
  const world = hashed(REAL_CLIENT);

  const strict = new ContentGate('strict');
  strict.setAuthoritative(world);
  const r = strict.check(REAL_CLIENT); // no sha256 fields at all
  assert.equal(r.ok, false,
    'strict must NOT silently degrade to names for a client that cannot hash — that client '
    + 'is exactly the one most likely to have been modified');
  assert.match((r as { ok: false; detail: string }).detail, /update your client/);

  const lenient = new ContentGate('names');
  lenient.setAuthoritative(world);
  assert.deepEqual(lenient.check(REAL_CLIENT), { ok: true },
    'under names the same client is fine — that is what names means');
});

test('strict: matching hashes pass', () => {
  const gate = new ContentGate('strict');
  gate.setAuthoritative(hashed(REAL_CLIENT));
  assert.deepEqual(gate.check(hashed(REAL_CLIENT)), { ok: true });
});

test('strict: a server with no hashes of its own does not refuse anyone', () => {
  // Tier 1, or files the server could not read. Nothing to compare against, so nothing to
  // refuse on — a hash we failed to compute must not lock out every player.
  const gate = new ContentGate('strict');
  gate.setAuthoritative(REAL_CLIENT); // canonical carries no sha256
  assert.deepEqual(gate.check(hashed(REAL_CLIENT)), { ok: true });
});
