// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M3: refKey forms, spawn ack/place ordering, cell-scoped fan-out, tombstones,
// container first-open capture + transactional conservation, WorldCellState on
// entry/resync, doc persistence + netId continuity across restart.

import test from 'node:test';
import assert from 'node:assert/strict';
import { contentRefKey, netRefKey, parseRefKey } from '../src/proto/ref';
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

    b.sendEvent('ContainerOpRequest', { ref: CONT_REF, cellKey: '0,0', opId: 2, op: 'take', itemId: 'gold_001', n: 400 }); // only 300 left
    const r2 = (await b.waitEvent('ContainerOpResult')).value as { ok: boolean; reason?: string };
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, 'gone');

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
    a.sendEvent('ResyncRequest', { cellKey: '0,0' });
    const state = (await a.waitEvent('WorldCellState')).value as { placed: unknown[]; deleted: string[] };
    assert.deepEqual(state.placed, []);
    assert.deepEqual(state.deleted.filter((k) => k === `n:${barrelNetId}`), [`n:${barrelNetId}`]); // exactly one tombstone
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
    assert.ok(state.deleted.includes(`n:${barrelNetId}`), 'tombstone survived restart');
    assert.ok(state.containers[CONT_KEY], 'container canonical survived restart');
    d.sendEvent('ObjectSpawnRequest', { tempId: 1, recordId: 'crate_01', cellKey: '0,0', x: 0, y: 0, z: 0, rotZ: 0, count: 1 });
    const ack = (await d.waitEvent('ObjectSpawnAck')).value as { netId: number };
    assert.ok(ack.netId > barrelNetId, `netId ${ack.netId} must never reuse (${barrelNetId} was issued pre-restart)`);
    d.close();
    await d.closed;
  });
});
