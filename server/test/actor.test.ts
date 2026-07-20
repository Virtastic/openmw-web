// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M4 over real clients: actor codec, grant/info on entry, epoch-guarded & holder-only
// relay, cell-scoped fan-out, ActorDeath dedup + kill tally, snapshot -> dormant fold ->
// re-grant.

import test from 'node:test';
import assert from 'node:assert/strict';
import { packActorMoveBatch, unpackActorMoveBatch, type ActorEntry } from '../src/proto/movement';
import { startServer, type RunningServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const ACTOR_REF = { __refnum: { index: 42, contentFile: 0 } };
const REF_ENTRY: ActorEntry = {
  ref: { index: 42, contentFile: 0 },
  pose: { x: 7.5, y: -3, z: 100, yaw: 0x2000, pitch: 0x30, flags: 0b100, animVel: 128, counter: 0 },
};

test('ActorMoveBatch codec round-trips', () => {
  const buf = packActorMoveBatch(5, [REF_ENTRY]);
  // header: epoch u32 LE, count u8
  assert.deepEqual([...buf.subarray(0, 5)], [0x05, 0x00, 0x00, 0x00, 0x01]);
  assert.deepEqual([...buf.subarray(5, 13)], [0x2a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]); // ref 42/0
  const back = unpackActorMoveBatch(buf);
  assert.equal(back.epoch, 5);
  assert.deepEqual(back.entries, [REF_ENTRY]);
});

test('actor authority and relay end to end', async (t) => {
  const dataDir = tmpDataDir();
  let server: RunningServer = await startServer({ dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  const { playerId: aId } = await a.joinAsNew('Alice');
  await a.waitEvent('PlayerList');

  let epochA = 0;
  await t.test('first entrant is granted authority', async () => {
    a.sendCellChange('0,0', 0, 0, 0);
    await a.waitEvent('PlayerCellChange');
    const grant = await a.waitEvent('ActorAuthorityGrant');
    assert.equal((grant.value as { cellKey: string }).cellKey, '0,0');
    epochA = (grant.value as { epoch: number }).epoch;
    assert.ok(epochA >= 1);
    assert.deepEqual((grant.value as { snapshot: unknown }).snapshot, { actors: [] });
  });

  const b = await TestClient.connect(server.port);
  const { playerId: bId } = await b.joinAsNew('Bob');
  await b.waitEvent('PlayerList');

  await t.test('second entrant to a held cell gets Info, not Grant', async () => {
    b.sendCellChange('0,0', 0, 0, 0);
    await b.waitEvent('PlayerCellChange');
    const info = await b.waitEvent('ActorAuthorityInfo');
    assert.deepEqual(info.value, { cellKey: '0,0', holderId: aId });
    // Info goes only to the entrant; Alice (already holding) gets nothing here, and no
    // Grant reaches Bob.
    b.sendEvent('ChatSend', { text: 'fence' });
    await b.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'fence');
    assert.equal(b.inbox.events.filter((e) => e.name === 'ActorAuthorityGrant').length, 0);
  });

  await t.test('holder actor batch relays cell-scoped; non-holder is dropped', async () => {
    a.sendActorMoveBatch(epochA, [REF_ENTRY]);
    const got = await b.waitActorBatch();
    assert.equal(got.batch.epoch, epochA);
    assert.deepEqual(got.batch.entries, [REF_ENTRY]);
    // Holder does not receive its own actor batch.
    assert.equal(a.inbox.actorBatches.length, 0);

    // Bob (non-holder) tries to send an actor batch -> dropped, Alice sees nothing.
    b.sendActorMoveBatch(epochA, [REF_ENTRY]);
    a.sendActorMoveBatch(epochA, [{ ...REF_ENTRY, pose: { ...REF_ENTRY.pose, x: 55 } }]);
    const next = await b.waitActorBatch();
    assert.equal(next.batch.entries[0]!.pose.x, 55); // Alice's, not Bob's echo
    assert.equal(a.inbox.actorBatches.length, 0);
  });

  await t.test('stale epoch is dropped for event-tier actor messages', async () => {
    a.sendEvent('ActorStatsDynamic', { cellKey: '0,0', epoch: epochA, ref: ACTOR_REF, hp: { c: 10, b: 20 }, mp: { c: 1, b: 2 }, ft: { c: 3, b: 4 } });
    const stats = await b.waitEvent('ActorStatsDynamic');
    assert.equal((stats.value as { epoch: number }).epoch, epochA);
    // Wrong epoch -> silently dropped.
    a.sendEvent('ActorStatsDynamic', { cellKey: '0,0', epoch: epochA + 99, ref: ACTOR_REF, hp: { c: 0, b: 20 }, mp: { c: 1, b: 2 }, ft: { c: 3, b: 4 } });
    a.sendEvent('ChatSend', { text: 'sfence' });
    await b.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'sfence');
    assert.equal(b.inbox.events.filter((e) => e.name === 'ActorStatsDynamic').length, 0);
  });

  await t.test('far player receives no actor traffic', async () => {
    const c = await TestClient.connect(server.port);
    await c.joinAsNew('Cara');
    await c.waitEvent('PlayerList');
    c.sendCellChange('40,40', 0, 0, 0); // far from 0,0
    await c.waitEvent('PlayerCellChange');
    await c.waitEvent('ActorAuthorityGrant'); // Cara holds her own far cell
    c.inbox.actorBatches.length = 0;
    a.sendActorMoveBatch(epochA, [REF_ENTRY]);
    await b.waitActorBatch();
    c.sendEvent('ChatSend', { text: 'cfence' }); // fence Cara's own socket
    await c.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'cfence');
    assert.equal(c.inbox.actorBatches.length, 0);
    c.close();
    await c.closed;
  });

  await t.test('ActorDeath dedups by (ref, deathNo) and bumps the shared kill tally', async () => {
    a.sendEvent('ActorDeath', { cellKey: '0,0', epoch: epochA, ref: ACTOR_REF, killerPlayerId: aId, deathNo: 1, killedRecordId: 'cliffracer' });
    const death = await b.waitEvent('ActorDeath');
    assert.equal((death.value as { deathNo: number }).deathNo, 1);
    const kc = await b.waitEvent('WorldKillCount');
    assert.deepEqual(kc.value, { refId: 'cliffracer', count: 1 });
    await a.waitEvent('WorldKillCount'); // broadcast reaches the holder too

    // Duplicate (same ref+deathNo) -> no relay, no tally bump.
    b.inbox.events.length = 0;
    a.sendEvent('ActorDeath', { cellKey: '0,0', epoch: epochA, ref: ACTOR_REF, killerPlayerId: aId, deathNo: 1, killedRecordId: 'cliffracer' });
    a.sendEvent('ChatSend', { text: 'dfence' });
    await b.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'dfence');
    assert.equal(b.inbox.events.filter((e) => e.name === 'ActorDeath' || e.name === 'WorldKillCount').length, 0);

    // A second, higher deathNo counts again.
    a.sendEvent('ActorDeath', { cellKey: '0,0', epoch: epochA, ref: ACTOR_REF, killerPlayerId: aId, deathNo: 2, killedRecordId: 'cliffracer' });
    assert.deepEqual((await b.waitEvent('WorldKillCount')).value, { refId: 'cliffracer', count: 2 });
  });

  let snapEpoch = 0;
  await t.test('snapshot -> dormant fold -> re-grant carries it', async () => {
    // Alice pushes a snapshot, then both leave 0,0 so it goes dormant.
    a.sendEvent('ActorSnapshot', { cellKey: '0,0', epoch: epochA, actors: [{ ref: ACTOR_REF, x: 1, y: 2, z: 3, dead: false }] });
    b.sendCellChange('40,0', 0, 0, 0); // Bob leaves 0,0 (non-holder)
    await b.waitEvent('PlayerCellChange');
    a.sendCellChange('40,0', 0, 0, 0); // Alice (holder) leaves -> 0,0 empty -> dormant fold
    await a.waitEvent('PlayerCellChange');
    await a.waitEvent('ActorAuthorityRevoke', (v) => (v as { cellKey: string }).cellKey === '0,0');

    // Re-enter 0,0: fresh grant carries the folded snapshot.
    a.sendCellChange('0,0', 0, 0, 0);
    await a.waitEvent('PlayerCellChange');
    const grant = await a.waitEvent('ActorAuthorityGrant', (v) => (v as { cellKey: string }).cellKey === '0,0');
    snapEpoch = (grant.value as { epoch: number }).epoch;
    assert.ok(snapEpoch > epochA, 'epoch must climb across dormancy');
    assert.deepEqual((grant.value as { snapshot: { actors: unknown[] } }).snapshot.actors, [
      { ref: ACTOR_REF, x: 1, y: 2, z: 3, dead: false },
    ]);
  });

  await t.test('kill tally persists across restart', async () => {
    a.close();
    b.close();
    await a.closed;
    await b.closed;
    await server.close();
    server = await startServer({ dataDir, port: 0, host: '127.0.0.1' });

    const d = await TestClient.connect(server.port);
    await d.joinAsNew('Dagoth');
    await d.waitEvent('PlayerList');
    d.sendCellChange('7,7', 0, 0, 0);
    await d.waitEvent('PlayerCellChange');
    const grant = await d.waitEvent('ActorAuthorityGrant');
    const ep = (grant.value as { epoch: number }).epoch;
    // A new kill on the same recordId must continue from the persisted count (2 -> 3).
    d.sendEvent('ActorDeath', { cellKey: '7,7', epoch: ep, ref: { __refnum: { index: 1, contentFile: 0 } }, killerPlayerId: 1, deathNo: 1, killedRecordId: 'cliffracer' });
    const kc = await d.waitEvent('WorldKillCount');
    assert.deepEqual(kc.value, { refId: 'cliffracer', count: 3 });
    d.close();
    await d.closed;
  });
});
