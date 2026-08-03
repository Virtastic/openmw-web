// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// A client authors its OWN character: PlayerInventory/PlayerLevel overwrite the doc with
// whatever is sent (playerstate.ts), and the sim peer does not guard this — its one
// anti-cheat role is cell authority over NPCs (worldstate.handleActorMoveBatch). Containers
// are transactional, but PlayerInventory bypasses them entirely.
//
// So this is telemetry, not enforcement, matching the movement envelope exactly: absurd-only
// thresholds, counted and fed to moderation, never rejected — a false positive on a real
// player is worse than a cheat that has to stay under the bar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir, readPlayerDoc } from './helpers';

test('an absurd declared hoard is recorded as an anomaly, and still stored', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: { metrics: { enabled: true, token: 'tok' } } });
  t.after(() => server.close());

  const c = await TestClient.connect(server.port);
  const { welcome } = await c.joinAsNew('Hoarder');
  const charId = String(welcome['characterId']);
  await c.waitEvent('PlayerList');

  // A normal haul first: this must NOT trip anything.
  c.sendEvent('PlayerInventory', { items: [{ id: 'gold_001', n: 400 }, { id: 'arrow', n: 200 }] });
  await new Promise((r) => setTimeout(r, 250));
  const scrape = async (): Promise<string> => (await fetch(
    `http://127.0.0.1:${server.port}/metrics`, { headers: { authorization: 'Bearer tok' } })).text();
  const gains = (text: string): number => {
    const m = /omwmp_implausible_gains_total\{kind="inventory_stack"\}\s+(\d+)/.exec(text);
    return m ? Number(m[1]) : 0;
  };
  const quiet = await scrape();
  assert.match(quiet, /omwmp_implausible_gains_total/,
    'the counter must be registered, or the assertion below proves nothing');
  assert.equal(gains(quiet), 0, 'a legitimate haul must not be flagged');

  // Now a declaration no play session produces.
  c.sendEvent('PlayerInventory', { items: [{ id: 'gold_001', n: 9999 }] });
  await new Promise((r) => setTimeout(r, 250));

  assert.equal(gains(await scrape()), 1, 'the absurd declaration was not recorded');

  // Stored anyway — this path never rejects, exactly like the movement envelope.
  await server.flush();
  const doc = readPlayerDoc(dataDir, charId);
  assert.deepEqual(doc?.['inventory'], [{ id: 'gold_001', n: 9999 }],
    'the declaration must still be stored; rejecting would rubber-band real players');
  c.close();
});

// ObjectSpawnRequest (dropping) places a recordId + count into the world for EVERYONE, and
// took no account of whether the sender owned any. In the public world that is a direct route
// for a modified client to put anything in front of 256 people. noDrop does not cover it — it
// only strips unique-actor corpses.
test('in your OWN world an unowned drop is counted, not refused', async (t) => {
  const dataDir = tmpDataDir();
  // worldMode 'private' -> noDrop off: your own campaign, where a bad drop harms nobody.
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    worldMode: 'private', worldOwner: 'dropper',
    configOverride: { metrics: { enabled: true, token: 'tok' } } });
  t.after(() => server.close());

  const c = await TestClient.connect(server.port);
  await c.joinAsNew('Dropper');
  await c.waitEvent('PlayerList');
  c.sendCellChange('0,0', 0, 0, 0);
  await c.waitEvent('PlayerCellChange');

  const scrape = async (): Promise<string> => (await fetch(
    `http://127.0.0.1:${server.port}/metrics`, { headers: { authorization: 'Bearer tok' } })).text();
  const drops = (t2: string): number => {
    const m = /omwmp_unowned_drops_total\s+(\d+)/.exec(t2);
    return m ? Number(m[1]) : 0;
  };
  assert.match(await scrape(), /omwmp_unowned_drops_total/, 'counter must be registered');

  // Declare a modest inventory, then drop what it contains: must NOT flag.
  c.sendEvent('PlayerInventory', { items: [{ id: 'iron_dagger', n: 2 }] });
  await new Promise((r) => setTimeout(r, 200));
  c.sendEvent('ObjectSpawnRequest', {
    tempId: 1, recordId: 'iron_dagger', cellKey: '0,0', x: 1, y: 2, z: 3, rotZ: 0, count: 1 });
  await c.waitEvent('ObjectSpawnAck');
  assert.equal(drops(await scrape()), 0, 'dropping what you hold must not be flagged');

  // Now drop something never declared at all.
  c.sendEvent('ObjectSpawnRequest', {
    tempId: 2, recordId: 'daedric_claymore', cellKey: '0,0', x: 1, y: 2, z: 3, rotZ: 0, count: 40 });
  await c.waitEvent('ObjectSpawnAck', (v) => (v as { tempId?: number }).tempId === 2, 6000);
  assert.equal(drops(await scrape()), 1,
    'an unowned drop in your own world must still be RECORDED, just not refused');
  c.close();
});

// Enforcement was backed out once because ObjectSpawnRequest is the generic "place an
// object" — s31 spawns a chest nobody carries. The client now says WHICH it is
// (fromInventory), so conservation is enforceable for real drops while placements still work.
// Both halves are asserted here; losing either one is a regression.
test('placements and drops both land; the drop is merely recorded', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: { economy: { noDrop: true } } }); // what the public world runs with
  t.after(() => server.close());

  const c = await TestClient.connect(server.port);
  await c.joinAsNew('Smuggler');
  await c.waitEvent('PlayerList');
  c.sendCellChange('0,0', 0, 0, 0);
  await c.waitEvent('PlayerCellChange');
  c.sendEvent('PlayerInventory', { items: [{ id: 'iron_dagger', n: 1 }] });
  await new Promise((r) => setTimeout(r, 200));

  // A PLACEMENT (no fromInventory): scripts place things nobody carries. Must still work.
  c.sendEvent('ObjectSpawnRequest', {
    tempId: 11, recordId: 'daedric_claymore', cellKey: '0,0', x: 1, y: 2, z: 3, rotZ: 0, count: 40 });
  assert.ok(await c.waitEvent('ObjectSpawnAck', (v) => (v as { tempId?: number }).tempId === 11, 6000),
    'placement must still happen — a chest is spawned by scripts, not carried');

  // A real DROP of something never held is RECORDED but still placed: refusing it broke s30,
  // because a pick-up-then-immediate-drop outruns the client's 2 s inventory diff. Enforcement
  // lives at the account level (containment) instead.
  c.sendEvent('ObjectSpawnRequest', {
    tempId: 12, recordId: 'daedric_claymore', cellKey: '0,0', x: 1, y: 2, z: 3, rotZ: 0,
    count: 40, fromInventory: true });
  assert.ok(await c.waitEvent('ObjectSpawnAck', (v) => (v as { tempId?: number }).tempId === 12, 6000),
    'refusing a drop breaks legitimate play — see s30');

  // ...and a drop of something you DO hold obviously works.
  c.sendEvent('ObjectSpawnRequest', {
    tempId: 13, recordId: 'iron_dagger', cellKey: '0,0', x: 1, y: 2, z: 3, rotZ: 0,
    count: 1, fromInventory: true });
  assert.ok(await c.waitEvent('ObjectSpawnAck', (v) => (v as { tempId?: number }).tempId === 13, 6000),
    'dropping what you hold must still work');
  c.close();
});

// CONTAINMENT. Character state is client-declared and the server can only detect, not
// prevent. So bound the blast radius: an account that has declared impossible state cannot
// hand anything to anyone in the SHARED world — no drops, no container puts, no PvP. Their
// own campaign is untouched, because cheating there harms nobody. Quarantines the ACCOUNT,
// not the item: per-item provenance needs acquisition paths the server cannot yet see.
test('a quarantined account cannot put anything into the shared world', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: { economy: { noDrop: true }, metrics: { enabled: true, token: 'tok' } } });
  t.after(() => server.close());

  const c = await TestClient.connect(server.port);
  await c.joinAsNew('Cheat');
  await c.waitEvent('PlayerList');
  c.sendCellChange('0,0', 0, 0, 0);
  await c.waitEvent('PlayerCellChange');

  // Clean so far: a normal drop of a held item works.
  c.sendEvent('PlayerInventory', { items: [{ id: 'iron_dagger', n: 2 }] });
  await new Promise((r) => setTimeout(r, 200));
  c.sendEvent('ObjectSpawnRequest', {
    tempId: 1, recordId: 'iron_dagger', cellKey: '0,0', x: 1, y: 2, z: 3, rotZ: 0, count: 1 });
  assert.ok(await c.waitEvent('ObjectSpawnAck', (v) => (v as { tempId?: number }).tempId === 1, 6000),
    'a clean account must be able to play normally');

  // Declare something impossible -> quarantined from here on.
  c.sendEvent('PlayerInventory', { items: [{ id: 'gold_001', n: 9999 }] });
  await new Promise((r) => setTimeout(r, 300));

  c.sendEvent('ObjectSpawnRequest', {
    tempId: 2, recordId: 'gold_001', cellKey: '0,0', x: 1, y: 2, z: 3, rotZ: 0, count: 1 });
  const refused = await c.waitEvent('ObjectSpawnAck',
    (v) => (v as { tempId?: number }).tempId === 2, 2500).catch(() => null);
  assert.equal(refused, null, 'a quarantined account dropped into the shared world');

  const text = await (await fetch(`http://127.0.0.1:${server.port}/metrics`,
    { headers: { authorization: 'Bearer tok' } })).text();
  assert.match(text, /omwmp_contained_actions_total\{action="drop"\}\s+1/,
    'the refusal must be counted: ' + (/omwmp_contained_actions_total.*/.exec(text)?.[0] ?? 'absent'));
  c.close();
});

test('containment does NOT apply in your own world', async (t) => {
  const dataDir = tmpDataDir();
  // noDrop off = not the shared world. Your own campaign, your own business.
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    worldMode: 'private', worldOwner: 'cheat2' });
  t.after(() => server.close());

  const c = await TestClient.connect(server.port);
  await c.joinAsNew('Cheat2');
  await c.waitEvent('PlayerList');
  c.sendCellChange('0,0', 0, 0, 0);
  await c.waitEvent('PlayerCellChange');
  c.sendEvent('PlayerInventory', { items: [{ id: 'gold_001', n: 9999 }] });
  await new Promise((r) => setTimeout(r, 300));

  c.sendEvent('ObjectSpawnRequest', {
    tempId: 3, recordId: 'gold_001', cellKey: '0,0', x: 1, y: 2, z: 3, rotZ: 0, count: 1 });
  assert.ok(await c.waitEvent('ObjectSpawnAck', (v) => (v as { tempId?: number }).tempId === 3, 6000),
    'containment must not reach into a private campaign');
  c.close();
});
