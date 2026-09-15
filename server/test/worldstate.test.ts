// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M3: refKey forms, spawn ack/place ordering, cell-scoped fan-out, tombstones,
// container first-open capture + transactional conservation, WorldCellState on
// entry/resync, doc persistence + netId continuity across restart.

import test from 'node:test';
import assert from 'node:assert/strict';
import { contentRefKey, netRefKey, parseRefKey } from '../src/proto/ref';
import { CellStore, MAX_KEYS_PER_CELL, emptyCellDoc } from '../src/persist/cellstore';
import { cellStateBody, CELL_STATE_NODE_BUDGET } from '../src/core/worldstate';
import { jsToL, lserEncode, lserDecode, lserNodeCount, LSER_MAX_NODES } from '../src/proto/lser';
import { startServer, type RunningServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const CONT_REF = { __refnum: { index: 77, contentFile: 0 } };
const CONT_KEY = 'c:77:0';

test('refKey forms round-trip', () => {
  assert.equal(contentRefKey(123, -1), 'c:123:-1');
  assert.equal(netRefKey(42), 'n:42');
  assert.deepEqual(parseRefKey('c:123:-1'), { kind: 'ref', index: 123, contentFile: -1, key: 'c:123:-1' });
  assert.deepEqual(parseRefKey('n:42'), { kind: 'net', netId: 42, key: 'n:42' });
  assert.equal(parseRefKey('x:1'), null);
  assert.equal(parseRefKey('n:-1'), null);
});

test('world objects and containers end to end', async (t) => {
  const dataDir = tmpDataDir();
  let server: RunningServer = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  const { playerId: aId } = await a.joinAsNew('Alice');
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  await a.waitEvent('PlayerCellChange');
  await a.waitEvent('WorldCellState'); // entry always yields the (empty) delta doc

  const b = await TestClient.connect(server.port);
  await b.joinAsNew('Bob');
  await b.waitEvent('PlayerList');
  b.sendCellChange('9,9', 0, 0, 0); // far from Alice
  await b.waitEvent('PlayerCellChange');
  const bEmpty = await b.waitEvent('WorldCellState');
  assert.equal((bEmpty.value as { cellKey: string }).cellKey, '9,9');
  assert.deepEqual((bEmpty.value as { placed: unknown }).placed, []); // untouched cell -> empty doc, still sent

  let barrelNetId = 0;

  await t.test('spawn: Ack precedes Place for the requester; far player sees neither', async () => {
    a.sendEvent('ObjectSpawnRequest', { tempId: 7, recordId: 'barrel_01', cellKey: '0,0', x: 10, y: 20, z: 30, rotZ: 1.5, count: 1 });
    const ack = await a.waitEvent('ObjectSpawnAck');
    const place = await a.waitEvent('ObjectPlace');
    assert.equal((ack.value as { tempId: number }).tempId, 7);
    barrelNetId = (ack.value as { netId: number }).netId;
    assert.ok(barrelNetId >= 1);
    assert.deepEqual(place.value, { netId: barrelNetId, recordId: 'barrel_01', cellKey: '0,0', x: 10, y: 20, z: 30, rotZ: 1.5, count: 1, byId: aId });
    assert.ok(ack.seq < place.seq, 'Ack must be sent before Place on the requester socket');
    // Fence Bob's socket: chat is enqueued after any would-be Place.
    a.sendEvent('ChatSend', { text: 'spawn-fence' });
    await b.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'spawn-fence');
    assert.equal(b.inbox.events.filter((e) => e.name === 'ObjectPlace').length, 0);
  });

  // REACH. The actor family checks holder+epoch; this family checked nothing at all, so any
  // authed client could delete/move/lock/unlock any object in any cell in the world, from
  // anywhere, persisted — ObjectDelete writes a permanent tombstone. Proximity is the rule
  // now: you may edit what you could see.
  await t.test('an object op on a far-away cell is refused, not persisted', async () => {
    const far = 'a-cell-nobody-is-in';
    const ref = { __refnum: { index: 900, contentFile: 0 } };
    a.sendEvent('ObjectLock', { ref, cellKey: far, lockLevel: 90 });
    a.sendEvent('ObjectDelete', { ref, cellKey: far });
    // Fence on a cell we ARE in: once this round-trips, the far ops have been processed too.
    a.sendEvent('ObjectLock', { ref: { __refnum: { index: 901, contentFile: 0 } }, cellKey: '0,0', lockLevel: 10 });
    await a.waitEvent('ObjectLock');

    // THE DOC is the evidence, not the inbox: the relay is already cell-scoped, so nobody
    // sees a far-cell op either way — what made this dangerous was that it PERSISTED, and
    // ObjectDelete's tombstone is permanent.
    await server.flush(); // write-behind store: without this the read below is vacuous
    const store = new CellStore(dataDir);
    // Control: the NEAR lock must be visible through this same read, or the assertions below
    // prove nothing about the far one (a lazy flush would make both look empty).
    assert.equal(Object.keys((await store.get('0,0')).locks).length > 0, true,
      'the in-reach lock is not visible through this read — the far-cell assertions are vacuous');
    const doc = await store.get(far);
    assert.deepEqual(doc.locks, {}, 'an out-of-reach lock was persisted');
    assert.deepEqual(doc.deleted, [], 'an out-of-reach delete wrote a permanent tombstone');
  });

  await t.test('move/lock/door relay cell-scoped with sender id and land in the doc', async () => {
    const doorRef = { __refnum: { index: 500, contentFile: 2 } };
    a.sendEvent('ObjectMove', { ref: { __refnum: { index: 123, contentFile: 0 } }, cellKey: '0,0', x: 1, y: 2, z: 3, rotZ: 0.5 });
    const mv = await a.waitEvent('ObjectMove');
    assert.deepEqual(mv.value, { ref: { __refnum: { index: 123, contentFile: 0 } }, cellKey: '0,0', x: 1, y: 2, z: 3, rotZ: 0.5, byId: aId });
    a.sendEvent('ObjectLock', { ref: { __refnum: { index: 200, contentFile: 0 } }, cellKey: '0,0', lockLevel: 50 });
    assert.equal(((await a.waitEvent('ObjectLock')).value as { lockLevel: number }).lockLevel, 50);
    a.sendEvent('ObjectLock', { ref: { __refnum: { index: 201, contentFile: 0 } }, cellKey: '0,0' }); // nil = unlocked
    assert.equal(((await a.waitEvent('ObjectLock')).value as { lockLevel?: number }).lockLevel, undefined);
    a.sendEvent('DoorState', { ref: doorRef, cellKey: '0,0', open: true });
    assert.deepEqual((await a.waitEvent('DoorState')).value, { ref: doorRef, cellKey: '0,0', open: true, byId: aId });

    a.inbox.events.length = 0; // entry sent the 3x3's records; only the answer to THIS request counts
    a.sendEvent('ResyncRequest', { cellKey: '0,0' });
    const state = (await a.waitEvent('WorldCellState')).value as {
      moved: Record<string, unknown>; locks: Record<string, unknown>; doors: Record<string, boolean>;
    };
    assert.deepEqual(state.moved['c:123:0'], { x: 1, y: 2, z: 3, rotZ: 0.5 });
    assert.deepEqual(state.locks['c:200:0'], { lockLevel: 50 });
    assert.deepEqual(state.locks['c:201:0'], []); // empty table = unlocked (lToJs renders {} as [])
    assert.equal(state.doors['c:500:2'], true);
  });

  await t.test('container: first-open captures canonical, second opener is ignored', async () => {
    a.sendEvent('ContainerOpen', { ref: CONT_REF, cellKey: '0,0', contents: [{ id: 'gold_001', n: 500 }, { id: 'ash_yam', n: 5 }] });
    const st = (await a.waitEvent('ContainerState')).value as { items: { id: string; n: number }[]; stateSeq: number };
    assert.deepEqual(st.items, [{ id: 'gold_001', n: 500 }, { id: 'ash_yam', n: 5 }]);
    assert.equal(st.stateSeq, 1);
    // Bob comes adjacent and opens with a DIFFERENT roll: server truth wins.
    b.sendCellChange('0,1', 0, 0, 0);
    await b.waitEvent('WorldCellState', (v) => (v as { cellKey: string }).cellKey === '0,1');
    b.sendEvent('ContainerOpen', { ref: CONT_REF, cellKey: '0,0', contents: [{ id: 'gold_001', n: 99999e9 }] });
    const st2 = (await b.waitEvent('ContainerState')).value as { items: unknown };
    assert.deepEqual(st2.items, [{ id: 'gold_001', n: 500 }, { id: 'ash_yam', n: 5 }]);
  });

  await t.test('container transactions: reject on gone, update fan-out includes requester', async () => {
    a.sendEvent('ContainerOpRequest', { ref: CONT_REF, cellKey: '0,0', opId: 1, op: 'take', itemId: 'gold_001', n: 200 });
    const r1 = (await a.waitEvent('ContainerOpResult')).value as { opId: number; ok: boolean; stateSeq: number };
    assert.deepEqual(r1, { opId: 1, ok: true, stateSeq: 2 });
    const upA = (await a.waitEvent('ContainerUpdate')).value as { delta: { itemId: string; dn: number }; stateSeq: number };
    assert.deepEqual(upA.delta, { itemId: 'gold_001', dn: -200 });
    const upB = (await b.waitEvent('ContainerUpdate')).value as { stateSeq: number };
    assert.equal(upB.stateSeq, 2);

    // Bob took optimistically and his acquisition diff already credited it (backlog 235).
    b.sendEvent('PlayerItemAcquired', { id: 'gold_001', n: 400 });
    await new Promise((r) => setTimeout(r, 50));
    b.sendEvent('ContainerOpRequest', { ref: CONT_REF, cellKey: '0,0', opId: 2, op: 'take', itemId: 'gold_001', n: 400 }); // only 300 left
    const r2 = (await b.waitEvent('ContainerOpResult')).value as { ok: boolean; reason?: string };
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, 'gone');
    const bob = [...server.roster.inWorld()].find((p) => p.name === 'Bob');
    assert.equal(bob?.pendingAcquired?.get('gold_001'), undefined, 'a refused take must give its credit back');

    b.sendEvent('ContainerOpRequest', { ref: CONT_REF, cellKey: '0,0', opId: 3, op: 'put', itemId: 'iron_dagger', n: 2 });
    assert.equal(((await b.waitEvent('ContainerOpResult')).value as { ok: boolean }).ok, true);
    await a.waitEvent('ContainerUpdate', (v) => (v as { delta: { itemId: string } }).delta.itemId === 'iron_dagger');

    // Unopened container -> nostate.
    b.sendEvent('ContainerOpRequest', { ref: { __refnum: { index: 9999, contentFile: 0 } }, cellKey: '0,0', opId: 4, op: 'take', itemId: 'x', n: 1 });
    assert.equal(((await b.waitEvent('ContainerOpResult')).value as { reason?: string }).reason, 'nostate');
  });

  await t.test('conservation under random interleaved ops from 3 sessions', async () => {
    const c = await TestClient.connect(server.port);
    await c.joinAsNew('Cara');
    await c.waitEvent('PlayerList');
    c.sendCellChange('0,0', 0, 0, 0);
    await c.waitEvent('WorldCellState', (v) => (v as { cellKey: string }).cellKey === '0,0');

    const clients = [a, b, c];
    const OPS_PER_CLIENT = 30;
    let seed = 1234567;
    const rnd = (m: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % m);
    // Fire pipelined random gold takes/puts; opIds unique per client.
    for (let ci = 0; ci < clients.length; ci++) {
      for (let i = 0; i < OPS_PER_CLIENT; i++) {
        const op = rnd(2) === 0 ? 'take' : 'put';
        clients[ci]!.sendEvent('ContainerOpRequest', {
          ref: CONT_REF, cellKey: '0,0', opId: ci * 1000 + i, op, itemId: 'gold_001', n: 1 + rnd(20),
        });
      }
    }
    let delta = 0;
    let successes = 0;
    for (const client of clients) {
      for (let i = 0; i < OPS_PER_CLIENT; i++) {
        const r = (await client.waitEvent('ContainerOpResult', () => true, 10000)).value as {
          opId: number; ok: boolean;
        };
        if (r.ok) successes++;
      }
    }
    // Recompute expected from the authoritative update stream instead: each client saw
    // every successful op as a ContainerUpdate; sum deltas from one client's view.
    a.sendEvent('ChatSend', { text: 'cons-fence' });
    await a.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'cons-fence');
    for (const e of a.inbox.events.filter((x) => x.name === 'ContainerUpdate')) {
      const v = e.value as { delta: { itemId: string; dn: number } };
      if (v.delta.itemId === 'gold_001') delta += v.delta.dn;
    }
    a.inbox.events.length = 0;
    a.sendEvent('ContainerOpen', { ref: CONT_REF, cellKey: '0,0' }); // nil contents: read canonical
    const final = (await a.waitEvent('ContainerState')).value as { items: { id: string; n: number }[]; stateSeq: number };
    const gold = final.items.find((i) => i.id === 'gold_001')?.n ?? 0;
    assert.equal(gold, 300 + delta, 'canonical must equal prior state plus the update stream');
    assert.ok(successes > 0 && successes <= 3 * OPS_PER_CLIENT);
    assert.equal(final.stateSeq, 3 + successes); // 3 mutations before this subtest
    c.close();
    await c.closed;
  });

  await t.test('tombstones: delete of placed removes entry, idempotent re-delete', async () => {
    a.sendEvent('ObjectDelete', { net: barrelNetId, cellKey: '0,0' });
    await a.waitEvent('ObjectDelete', (v) => (v as { net?: number }).net === barrelNetId);
    a.sendEvent('ObjectDelete', { net: barrelNetId, cellKey: '0,0' }); // idempotent
    await a.waitEvent('ObjectDelete', (v) => (v as { net?: number }).net === barrelNetId);
    a.inbox.events.length = 0; // entry sent the 3x3's records; only the answer to THIS request counts
    a.sendEvent('ResyncRequest', { cellKey: '0,0' });
    const state = (await a.waitEvent('WorldCellState')).value as { placed: unknown[]; deleted: string[] };
    assert.deepEqual(state.placed, []);
    // Backlog 318: a spawned object's truth is `placed`; it takes NO tombstone (summons and
    // levelled spawns were filling the per-cell cap with keys nothing looks up).
    assert.deepEqual(state.deleted.filter((k) => k === `n:${barrelNetId}`), []);
  });

  await t.test('restart: docs persist, netId counter never reuses', async () => {
    a.close();
    b.close();
    await a.closed;
    await b.closed;
    await server.close();
    server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });

    const d = await TestClient.connect(server.port);
    d.hello();
    await d.waitJson('SessionHelloOk');
    d.login('Alice', 'hunter22');
    await d.waitJson('SessionWelcome');
    d.sendJson({ t: 'SessionReady' });
    await d.waitEvent('PlayerList');
    d.sendCellChange('0,0', 0, 0, 0);
    const state = (await d.waitEvent('WorldCellState')).value as {
      deleted: string[]; containers: Record<string, { items: { id: string; n: number }[]; stateSeq: number }>;
    };
    assert.ok(!(`n:${barrelNetId}` in ((state as { placed?: Record<string, unknown> }).placed ?? {})), 'the deletion survived restart');
    assert.ok(state.containers[CONT_KEY], 'container canonical survived restart');
    d.sendEvent('ObjectSpawnRequest', { tempId: 1, recordId: 'crate_01', cellKey: '0,0', x: 0, y: 0, z: 0, rotZ: 0, count: 1 });
    const ack = (await d.waitEvent('ObjectSpawnAck')).value as { netId: number };
    assert.ok(ack.netId > barrelNetId, `netId ${ack.netId} must never reuse (${barrelNetId} was issued pre-restart)`);
    d.close();
    await d.closed;
  });
});


// A DROP IS THE ITEM, NOT ITS RECORD. A placement carried the record and the count, so a friend
// picked up a pristine, fully charged copy of what was dropped -- a half-charged ring dropped
// and picked up was a free recharge. The dropped item's own state (wear, charge, soul) rides
// the request, the relay and the cell record; garbage in it is dropped, not the placement.
test("a dropped item's wear, charge and soul reach the other client and the cell record", async (t) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  await a.joinAsNew('Dropper');
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  await a.waitEvent('PlayerCellChange');
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Friend');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);
  await b.waitEvent('PlayerCellChange');
  a.sendEvent('ObjectSpawnRequest', {
    tempId: 1, recordId: 'ring_of_fire', cellKey: '0,0', x: 1, y: 2, z: 3, rotZ: 0, count: 1,
    state: { condition: 12, charge: 3.5, soul: 'scamp', junk: 'x' },
  });
  const seen = (await b.waitEvent('ObjectPlace')).value as { state?: Record<string, unknown> };
  assert.deepEqual(seen.state, { condition: 12, charge: 3.5, soul: 'scamp' }, 'the state reaches the other client');
  b.inbox.events.length = 0;
  b.sendEvent('ResyncRequest', { cellKey: '0,0' });
  const state = (await b.waitEvent('WorldCellState', (v) => (v as { cellKey: string }).cellKey === '0,0')).value as { placed: { state?: unknown }[] };
  assert.deepEqual(state.placed[0]?.state, { condition: 12, charge: 3.5, soul: 'scamp' }, 'and the cell record keeps it for a late joiner');
  // Garbage state is dropped; the placement itself is not.
  a.sendEvent('ObjectSpawnRequest', { tempId: 2, recordId: 'gold_001', cellKey: '0,0', x: 1, y: 2, z: 3, rotZ: 0, count: 5, state: { condition: -5, soul: 7 } });
  const plain = (await b.waitEvent('ObjectPlace', (v) => (v as { recordId: string }).recordId === 'gold_001')).value as { state?: unknown };
  assert.equal(plain.state, undefined);
});

// #189: the keyed maps (moved/locks/doors) had no cap. ~11k ObjectMoves from one client, each
// naming a fresh ref, pushed WorldCellState past the LSER node ceiling and every entrant
// thereafter disconnected BAD_PROTO — permanently, because the doc is persisted. A NEW key past
// MAX_KEYS_PER_CELL is refused; an existing key still updates.
test('a cell map at the cap refuses new keys and still updates existing ones', async (t) => {
  const dataDir = tmpDataDir();
  const seed = new CellStore(dataDir);
  const seeded = await seed.get('0,0');
  for (let i = 0; i < MAX_KEYS_PER_CELL; i++) seeded.moved[`c:${i}:5`] = { x: i, y: 0, z: 0, rotZ: 0 };
  seed.markDirty('0,0');
  await seed.close();

  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  await a.joinAsNew('Mover');
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  await a.waitEvent('WorldCellState');

  a.sendEvent('ObjectMove', { ref: { __refnum: { index: 99999, contentFile: 5 } }, cellKey: '0,0', x: 1, y: 2, z: 3, rotZ: 0 });
  a.sendEvent('ObjectMove', { ref: { __refnum: { index: 1, contentFile: 5 } }, cellKey: '0,0', x: 7, y: 8, z: 9, rotZ: 0 });
  // The second (existing key) relays; the first (new key past the cap) must not have.
  const mv = (await a.waitEvent('ObjectMove')).value as { ref: { __refnum: { index: number } }; x: number };
  assert.equal(mv.ref.__refnum.index, 1);
  assert.equal(mv.x, 7);
  await server.flush();
  const store = new CellStore(dataDir);
  const doc = await store.get('0,0');
  assert.equal(Object.keys(doc.moved).length, MAX_KEYS_PER_CELL, 'the cap held');
  assert.equal(doc.moved['c:99999:5'], undefined);
  assert.equal(doc.moved['c:1:5']?.x, 7, 'an existing key still updates');
  await store.close();
});

// Backlog 213/218: Startup and dialogue scripts toggle refs in cells the player has never
// seen, and the client reports them under the OBJECT's cell. No reach gate for enable/disable;
// both states persist and replay to whoever enters later.
test("a human's far-cell disable persists and replays; a later enable persists and replays too", async (t) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const host = await TestClient.connect(server.port);
  t.after(() => host.close());
  await host.joinAsNew('Host');
  host.sendCellChange('0,0', 0, 0, 0);
  await host.waitEvent('PlayerCellChange');
  const gares = { __refnum: { index: 4242, contentFile: 0 } };
  // Backlog 384: the host has NEVER been through the cave; a quest enable into an unvisited
  // interior is the ordinary case.
  host.sendEvent('ObjectEnabled', { ref: gares, cellKey: 'ilunibi, soul\'s rattle', enabled: false }); // Startup, far away
  await new Promise((r) => setTimeout(r, 200));

  const guest = await TestClient.connect(server.port);
  t.after(() => guest.close());
  await guest.joinAsNew('Guest');
  guest.sendCellChange('ilunibi, soul\'s rattle', 0, 0, 0);
  const first = (await guest.waitEvent('WorldCellState', (v) => (v as { cellKey: string }).cellKey === 'ilunibi, soul\'s rattle')).value as { disabled: string[]; enabled: string[] };
  assert.deepEqual(first.disabled, ['c:4242:0'], 'the far-cell disable did not persist');
  assert.deepEqual(first.enabled, []);

  // The host's dialogue later enables him -- still from afar, and it must OVERRIDE the disable.
  host.sendEvent('ObjectEnabled', { ref: gares, cellKey: 'ilunibi, soul\'s rattle', enabled: true });
  await guest.waitEvent('ObjectEnabled', (v) => (v as { enabled: boolean }).enabled === true);
  const late = await TestClient.connect(server.port);
  t.after(() => late.close());
  await late.joinAsNew('Late');
  late.sendCellChange('ilunibi, soul\'s rattle', 0, 0, 0);
  const second = (await late.waitEvent('WorldCellState', (v) => (v as { cellKey: string }).cellKey === 'ilunibi, soul\'s rattle')).value as { disabled: string[]; enabled: string[] };
  assert.deepEqual(second.disabled, [], 'the enable did not undo the persisted disable');
  assert.deepEqual(second.enabled, ['c:4242:0'], 'the enable did not persist as a reveal');
});

// Backlog 337/384: a far enable creates a cell doc for whatever key it names, so a far exterior
// has to be a real one inside the world; an interior needs no visit, and the per-session
// distinct-cell cap is what bounds the doc count.
test('a far enable persists for a real exterior, is refused past the world bound, and stops at the session cap', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const host = await TestClient.connect(server.port);
  t.after(() => host.close());
  await host.joinAsNew('Host');
  host.sendCellChange('0,0', 0, 0, 0);
  await host.waitEvent('PlayerCellChange');
  const ref = { __refnum: { index: 4242, contentFile: 0 } };
  host.sendEvent('ObjectEnabled', { ref, cellKey: '17,-9', enabled: false });
  host.sendEvent('ObjectEnabled', { ref, cellKey: 'ilunibi, soul\'s rattle', enabled: false }); // never visited
  host.sendEvent('ObjectEnabled', { ref, cellKey: '9999,0', enabled: false }); // outside the world
  // Two bursts under the 60 msg/s session bucket, so every enable reaches the cap check.
  for (let i = 0; i < 35; i++) host.sendEvent('ObjectEnabled', { ref, cellKey: `far interior ${i}`, enabled: false });
  await new Promise((r) => setTimeout(r, 1100));
  for (let i = 35; i < 70; i++) host.sendEvent('ObjectEnabled', { ref, cellKey: `far interior ${i}`, enabled: false });
  await new Promise((r) => setTimeout(r, 300));
  await server.flush();
  const store = new CellStore(dataDir);
  t.after(() => store.close());
  const stored = store.cellsWithDeltas();
  assert.deepEqual((await store.get('17,-9')).enabled, { 'c:4242:0': false }, 'a legitimate far exterior persists');
  assert.deepEqual((await store.get('ilunibi, soul\'s rattle')).enabled, { 'c:4242:0': false }, 'an unvisited interior persists (384)');
  assert.ok(!stored.includes('9999,0'), 'an exterior past the world bound must not create a doc');
  assert.equal(stored.filter((k) => k.startsWith('far interior ')).length, 64 - 2, 'the 64-per-session cap bounds the doc count');
});

// Backlog 338: a human's actor spawn is placed beside the asker, a few at a time.
test("a human's actor spawn is refused from afar and past ten bodies", async (t) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const bob = await TestClient.connect(server.port);
  t.after(() => bob.close());
  await bob.joinAsNew('Bob');
  bob.sendCellChange('0,0', 0, 0, 0);
  await bob.waitEvent('PlayerCellChange');
  const req = { tempId: 0, actor: true, recordId: 'dremora_lord', x: 100, y: 200, z: 0, rotZ: 0 };
  bob.sendEvent('ObjectSpawnRequest', { ...req, cellKey: '20,20', count: 1 });
  assert.equal(((await bob.waitEvent('ObjectSpawnRefused')).value as { reason: string }).reason, 'reach');
  bob.sendEvent('ObjectSpawnRequest', { ...req, cellKey: '0,0', count: 11 });
  assert.equal(((await bob.waitEvent('ObjectSpawnRefused')).value as { reason: string }).reason, 'reach');
  bob.sendEvent('ObjectSpawnRequest', { ...req, cellKey: '1,1', count: 10 }); // a neighbour cell, ten bodies: fine
  const spawn = (await bob.waitEvent('QuestSpawn')).value as { count: number };
  assert.equal(spawn.count, 10);
});

// Backlog 344: a 70-stack corpse (a merchant, a rich chest) is a container, not a hoard.
test('a first open of 70 stacks becomes canonical', async (t) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  await a.joinAsNew('Looter');
  a.sendCellChange('0,0', 0, 0, 0);
  await a.waitEvent('PlayerCellChange');
  const contents = Array.from({ length: 70 }, (_, i) => ({ id: `misc_item_${i}`, n: 1 }));
  a.sendEvent('ContainerOpen', { ref: CONT_REF, cellKey: '0,0', contents });
  const st = (await a.waitEvent('ContainerState')).value as { items: unknown[] };
  assert.equal(st.items.length, 70, 'the 70-stack container is canonical');
});

// Backlog 345: the trim drops loose litter before the net actors the holder still streams.
test('a trimmed cell state keeps its actors and sheds loose placed objects first', () => {
  const doc = emptyCellDoc();
  for (let i = 0; i < MAX_KEYS_PER_CELL; i++) {
    doc.placed[`n:${i}`] = { netId: i, recordId: 'misc_com_bottle_01', cellKey: '0,0', x: i, y: 0, z: 0, rotZ: 0, count: 1, byId: 1, state: { condition: 3 } };
    doc.deleted.push(`c:${i}:0`);
    doc.moved[`c:${i}:1`] = { x: i, y: 1, z: 2, rotZ: 3 };
    doc.locks[`c:${i}:2`] = i % 2 ? 50 : null;
    doc.doors[`c:${i}:3`] = true;
    doc.containers[`c:${i}:4`] = { stateSeq: 1, items: Array.from({ length: 32 }, (_, j) => ({ id: `item_${j}`, n: 1 })) };
    (doc.memberVars ??= {})[`c:${i}:5`] = { state: 1 };
  }
  // The newest placed entries are the actors.
  for (let i = 0; i < 20; i++) {
    doc.placed[`n:${9000 + i}`] = { netId: 9000 + i, recordId: 'cliff racer', cellKey: '0,0', x: i, y: 0, z: 0, rotZ: 0, count: 1, byId: 2, actor: true };
  }
  const body = cellStateBody('0,0', doc, [], true);
  assert.ok(lserNodeCount(body) <= CELL_STATE_NODE_BUDGET);
  const placed = body['placed'] as { netId: number; actor?: boolean }[];
  assert.ok(placed.length < MAX_KEYS_PER_CELL + 20, 'something was trimmed');
  assert.equal(placed.filter((p) => p.actor === true).length, 20, 'every actor survived the trim');
});

// Backlog 214: a client's PlaceAtPC actor is the HOLDER's to spawn (the client's engine
// declined to build a statue). Forwarded as QuestSpawn with its spot; rate-capped per player.
test("a human's actor spawn request is forwarded to the holder; the 11th in a minute is refused", async (t) => {
  const PEER_PASS = 'peer-secret-1';
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS } },
  });
  t.after(() => server.close());
  const bob = await TestClient.connect(server.port);
  t.after(() => bob.close());
  const { playerId: bobId } = await bob.joinAsNew('Bob');
  bob.sendCellChange('0,0', 0, 0, 0);
  await bob.waitEvent('PlayerCellChange');
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  peer.sendCellChange('0,0', 0, 0, 0);
  await peer.waitEvent('ActorAuthorityGrant', (v) => (v as { cellKey: string }).cellKey === '0,0');

  const req ={ tempId: 0, actor: true, recordId: 'dreamer_01', cellKey: '0,0', x: 100, y: 200, z: 0, rotZ: 0, count: 2 };
  bob.sendEvent('ObjectSpawnRequest', req);
  const spawn = (await peer.waitEvent('QuestSpawn')).value as Record<string, unknown>;
  assert.equal(spawn['recordId'], 'dreamer_01');
  assert.equal(spawn['x'], 100);
  assert.equal(spawn['count'], 2);
  assert.equal(spawn['forId'], bobId);
  assert.equal(bob.inbox.events.filter((e) => e.name === 'ObjectPlace').length, 0, 'the server placed the actor itself');

  for (let i = 0; i < 9; i++) bob.sendEvent('ObjectSpawnRequest', req);
  bob.sendEvent('ObjectSpawnRequest', req); // the 11th
  const refused = (await bob.waitEvent('ObjectSpawnRefused')).value as { reason: string };
  assert.equal(refused.reason, 'rate');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(peer.inbox.events.filter((e) => e.name === 'QuestSpawn').length, 9, 'the cap did not hold'); // 10 forwarded, the first consumed above
});

// Backlog 216: a PositionCell from a player-gated script moved a puppet on one client; the
// holder is told and moves the real actor.
test('ActorAI kind position from a non-holder reaches the holder', async (t) => {
  const PEER_PASS = 'peer-secret-1';
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS } },
  });
  t.after(() => server.close());
  const bob = await TestClient.connect(server.port);
  t.after(() => bob.close());
  await bob.joinAsNew('Bob');
  bob.sendCellChange('0,0', 0, 0, 0);
  await bob.waitEvent('PlayerCellChange');
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  peer.sendCellChange('0,0', 0, 0, 0);
  await peer.waitEvent('ActorAuthorityGrant', (v) => (v as { cellKey: string }).cellKey === '0,0');
  const dagoth = { __refnum: { index: 777, contentFile: 0 } };
  bob.sendEvent('ActorAI', { ref: dagoth, cellKey: '0,0', epoch: 0, position: { cell: 'akulakhan\'s chamber', x: 1, y: 2, z: 3 } });
  const got = (await peer.waitEvent('ActorAI', (v) => (v as { position?: unknown }).position !== undefined)).value as { position: Record<string, unknown> };
  assert.deepEqual(got.position, { cell: 'akulakhan\'s chamber', x: 1, y: 2, z: 3 });
  // ...but not from afar.
  peer.inbox.events.length = 0;
  bob.sendCellChange('20,20', 0, 0, 0);
  await bob.waitEvent('PlayerCellChange');
  bob.sendEvent('ActorAI', { ref: dagoth, cellKey: '0,0', epoch: 0, position: { cell: '', x: 1, y: 2, z: 3 } });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(peer.inbox.events.filter((e) => e.name === 'ActorAI').length, 0, 'a far position claim reached the holder');
});

// A human in 0,0 plus the sim peer holding it (as the ActorAI test above).
async function heldCell(t: { after(fn: () => unknown): void }) {
  const PEER_PASS = 'peer-secret-1';
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS }, limits: { maxConnsPerIp: 16 } },
  });
  t.after(() => server.close());
  const human = async (name: string) => {
    const c = await TestClient.connect(server.port);
    t.after(() => c.close());
    const { playerId } = await c.joinAsNew(name);
    await c.waitEvent('PlayerList');
    c.sendCellChange('0,0', 0, 0, 0);
    await c.waitEvent('PlayerCellChange');
    return { c, playerId };
  };
  const { c: bob } = await human('Bob');
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  peer.sendCellChange('0,0', 0, 0, 0);
  const epoch = ((await peer.waitEvent('ActorAuthorityGrant', (v) => (v as { cellKey: string }).cellKey === '0,0')).value as { epoch: number }).epoch;
  return { server, bob, peer, epoch, human };
}
const NPC = { __refnum: { index: 300, contentFile: 0 } };

// #229: Fight/Flee/Alarm ride ActorDisposition as `ai`. From the talking client (the
// dialogue-lock holder) each value is bounded to [0,100] -- out of bounds is refused whole
// (worldstate.ts `aiOk` beside the disposition bound); from the cell holder it relays verbatim.
test('ActorDisposition ai: bounded from the dialogue holder, relayed from the cell holder', async (t) => {
  const { bob, peer, epoch, human } = await heldCell(t);
  const { c: alice } = await human('Alice');
  alice.sendEvent('DialogueLock', { ref: NPC, cellKey: '0,0', want: true });
  assert.equal(((await alice.waitEvent('DialogueLockResult')).value as { granted: boolean }).granted, true);

  bob.inbox.events.length = 0;
  alice.sendEvent('ActorDisposition', { ref: NPC, cellKey: '0,0', epoch: 0, disposition: 60, ai: { fight: 30, flee: 0, alarm: 100 } });
  const got = (await bob.waitEvent('ActorDisposition')).value as { disposition: number; ai: Record<string, number> };
  assert.equal(got.disposition, 60);
  assert.deepEqual(got.ai, { fight: 30, flee: 0, alarm: 100 }, 'the taunt reaches the other screen');

  bob.inbox.events.length = 0;
  alice.sendEvent('ActorDisposition', { ref: NPC, cellKey: '0,0', epoch: 0, disposition: 60, ai: { fight: 101 } });
  alice.sendEvent('ActorDisposition', { ref: NPC, cellKey: '0,0', epoch: 0, disposition: 60, ai: { flee: -1 } });
  alice.sendEvent('ChatSend', { text: 'aifence' });
  await bob.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'aifence');
  assert.equal(bob.inbox.events.filter((e) => e.name === 'ActorDisposition').length, 0, 'an out-of-range AI setting was relayed');

  bob.inbox.events.length = 0;
  peer.sendEvent('ActorDisposition', { ref: NPC, cellKey: '0,0', epoch, disposition: 40, ai: { fight: 90 } });
  const fromHolder = (await bob.waitEvent('ActorDisposition')).value as { ai: Record<string, number> };
  assert.deepEqual(fromHolder.ai, { fight: 90 }, "the holder's beat carries the AI settings too");
});

// #293: ActorRevive is ActorDeath's inverse. The doc forgets the death (worldstate.ts
// `delete doc.actorDeaths[ref.key]`) and the room hears it; a later entrant is not told
// the resurrected NPC is dead.
test('a holder ActorRevive forgets the death: observers hear it, a later entrant sees no corpse', async (t) => {
  const { bob, peer, epoch, human } = await heldCell(t);
  peer.sendEvent('ActorDeath', { cellKey: '0,0', epoch, ref: NPC, deathNo: 1, killedRecordId: 'smuggler' });
  await bob.waitEvent('ActorDeath');
  peer.sendEvent('ActorRevive', { cellKey: '0,0', epoch, ref: NPC });
  const revive = (await bob.waitEvent('ActorRevive')).value as { ref: unknown };
  assert.deepEqual(revive.ref, NPC);

  const { c: walker } = await human('Walker');
  walker.inbox.events.length = 0;
  walker.sendCellChange('5,5', 0, 0, 0);
  await walker.waitEvent('PlayerCellChange');
  walker.sendCellChange('0,0', 0, 0, 0);
  const state = (await walker.waitEvent('WorldCellState', (v) => (v as { cellKey: string }).cellKey === '0,0')).value as { deaths: string[] };
  assert.deepEqual(state.deaths, [], 'the resurrected NPC is still listed dead for a newcomer');
});

// #296: the magic that SHOWS on an NPC. ActorEffects {add, remove} from the cell holder
// relays to the room; from anyone else it is dropped (worldstate.ts ACTOR_RELAY_EVENTS +
// authCheck).
test('ActorEffects relays from the holder and is refused from a non-holder', async (t) => {
  const { bob, peer, epoch } = await heldCell(t);
  const body = { ref: NPC, cellKey: '0,0', epoch, add: [{ id: 'chameleon', effect: 58, magnitude: 30 }], remove: ['invisibility'] };
  peer.sendEvent('ActorEffects', body);
  const got = (await bob.waitEvent('ActorEffects')).value as { add: unknown; remove: unknown };
  assert.deepEqual(got.add, body.add);
  assert.deepEqual(got.remove, body.remove);

  peer.inbox.events.length = 0;
  bob.sendEvent('ActorEffects', body);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(peer.inbox.events.filter((e) => e.name === 'ActorEffects').length, 0, "a bystander's effect claim was relayed");
});

// Backlog 84: AITravel walks, so a destination past two cells from the actor's own is not a
// dialogue result -- it is a client sending the NPC into the void. Interiors are origin-local.
test('ActorAI travel is bounded to two cells of the actor', async (t) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const join = async (name: string) => {
    const c = await TestClient.connect(server.port);
    t.after(() => c.close());
    await c.joinAsNew(name);
    c.sendCellChange('3,3', 0, 0, 0);
    await c.waitEvent('PlayerCellChange', (v) => (v as { cellKey: string }).cellKey === '3,3');
    return c;
  };
  const bob = await join('Bob');
  const eve = await join('Eve');
  const npc = { __refnum: { index: 778, contentFile: 0 } };
  bob.sendEvent('DialogueLock', { ref: npc, cellKey: '3,3', want: true });
  await bob.waitEvent('DialogueLockResult');
  const travel = (x: number, y: number) => bob.sendEvent('ActorAI', { ref: npc, cellKey: '3,3', epoch: 0, travel: { x, y, z: 0 } });
  travel(5 * 8192 + 10, 1 * 8192 + 10); // two cells over: allowed
  const got = (await eve.waitEvent('ActorAI', (v) => (v as { travel?: unknown }).travel !== undefined)).value as { travel: Record<string, number> };
  assert.equal(got.travel['x'], 5 * 8192 + 10);
  eve.inbox.events.length = 0;
  travel(6 * 8192 + 10, 3 * 8192); // three cells over: dropped
  bob.sendEvent('ChatSend', { text: 'fence' });
  await eve.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'fence');
  assert.equal(eve.inbox.events.filter((e) => e.name === 'ActorAI').length, 0, 'a far travel destination was relayed');
});

// Backlog 82: gold is never a placement. A human's gold drop is judged as a drop whether or
// not the client flagged it, so an undeclared purse on the ground is refused when enforcement
// is on -- the flag was the one thing a modified client could simply leave out.
test('a gold drop without fromInventory is still a drop', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { economy: { refuseUnownedDrops: true } },
  });
  t.after(() => server.close());
  const c = await TestClient.connect(server.port);
  t.after(() => c.close());
  await c.joinAsNew('Midas');
  c.sendCellChange('0,0', 0, 0, 0);
  await c.waitEvent('PlayerCellChange');
  c.sendEvent('PlayerInventory', { items: [{ id: 'gold_001', n: 10 }] });
  await new Promise((r) => setTimeout(r, 100));
  const drop = async (tempId: number, count: number) => {
    c.sendEvent('ObjectSpawnRequest', { tempId, recordId: 'gold_001', cellKey: '0,0', x: 0, y: 0, z: 0, rotZ: 0, count });
    const mine = (v: unknown) => (v as { tempId?: number }).tempId === tempId;
    return Promise.race([
      c.waitEvent('ObjectSpawnAck', mine, 10_000).then(() => 'ack'),
      c.waitEvent('ObjectSpawnRefused', mine, 10_000).then((e) => (e.value as { reason: string }).reason),
    ]);
  };
  assert.equal(await drop(1, 1000), 'unowned', 'gold the player never held was placed');
  assert.equal(await drop(2, 10), 'ack', 'and the gold they do hold drops');
});

// #269: the per-map caps add up to more than the LSER ceiling, so the frame is budgeted at
// send time. A doc with EVERY map at its cap must still decode on the client.
test('a cell doc at every cap is trimmed to a frame the decoder accepts', () => {
  const doc = emptyCellDoc();
  for (let i = 0; i < MAX_KEYS_PER_CELL; i++) {
    doc.placed[`n:${i}`] = { netId: i, recordId: 'misc_com_bottle_01', cellKey: '0,0', x: i, y: 0, z: 0, rotZ: 0, count: 1, byId: 1, state: { condition: 3 } };
    doc.deleted.push(`c:${i}:0`);
    doc.moved[`c:${i}:1`] = { x: i, y: 1, z: 2, rotZ: 3 };
    doc.locks[`c:${i}:2`] = i % 2 ? 50 : null;
    doc.doors[`c:${i}:3`] = true;
    doc.containers[`c:${i}:4`] = { stateSeq: 1, items: Array.from({ length: 32 }, (_, j) => ({ id: `item_${j}`, n: 1 })) };
    (doc.memberVars ??= {})[`c:${i}:5`] = { state: 1 };
    (doc.enabled ??= {})[`c:${i}:6`] = i % 2 === 0;
  }
  for (const withMemberVars of [true, false]) {
    const body = cellStateBody('0,0', doc, ['c:1:7'], withMemberVars);
    const nodes = lserNodeCount(body);
    assert.ok(nodes <= CELL_STATE_NODE_BUDGET, `${nodes} nodes over the budget`);
    assert.ok(nodes < LSER_MAX_NODES);
    const back = lserDecode(lserEncode(jsToL(body))) as Map<string, unknown>; // throws NODES past the ceiling
    assert.equal((back.get('deleted') as Map<number, unknown>).size, MAX_KEYS_PER_CELL, 'tombstones are never trimmed');
    assert.equal((back.get('locks') as Map<string, unknown>).size, MAX_KEYS_PER_CELL, 'locks are never trimmed');
    // The oldest drops survive; the trimmed tail is the newest (placed is the last resort).
    const placed = back.get('placed') as Map<number, Map<string, unknown>>;
    assert.ok(placed.size > MAX_KEYS_PER_CELL / 2 && placed.size < MAX_KEYS_PER_CELL, `placed kept ${placed.size}`);
    assert.equal(placed.get(1)!.get('netId'), 0);
    assert.equal((back.get('moved') as Map<string, unknown>).size, 0, 'moved goes first');
    assert.ok((back.get('containers') as Map<string, unknown>).size < MAX_KEYS_PER_CELL, 'containers go next');
  }
  // A small doc is sent whole: no trimming below the budget.
  const small = emptyCellDoc();
  small.moved['c:1:1'] = { x: 1, y: 2, z: 3, rotZ: 4 };
  assert.deepEqual(cellStateBody('0,0', small, [], true)['moved'], { 'c:1:1': { x: 1, y: 2, z: 3, rotZ: 4 } });
});
