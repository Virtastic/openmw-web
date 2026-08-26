// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M4 over real clients: actor codec, grant/info on entry, epoch-guarded & holder-only
// relay, cell-scoped fan-out, ActorDeath dedup + kill tally, snapshot -> dormant fold ->
// re-grant.

import test from 'node:test';
// The sim peer's credential: `system` is client-declared, so an empty [server].password
// refuses every peer.
const PEER_PASS = 'peer-secret-1';
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
  const cfg = { configOverride: { server: { password: PEER_PASS } } };
  let server: RunningServer = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1', ...cfg });
  t.after(() => server.close());

  // THE HOLDER IS THE SIM PEER. A player cannot hold a cell, so the thing that streams actor
  // state here has to be the peer — which is also what production does.
  const a = await TestClient.simPeer(server.port, PEER_PASS, 'Alice');
  const aId = a.playerId;

  let epochA = 0;
  await t.test('the sim peer is granted authority on entry', async () => {
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

  await t.test('a player entering a held cell gets Info, never Grant', async () => {
    b.sendCellChange('0,0', 0, 0, 0);
    await b.waitEvent('PlayerCellChange');
    const info = await b.waitEvent('ActorAuthorityInfo');
    // Info carries the live epoch so non-holders can address actors (M5 combat).
    assert.deepEqual(info.value, { cellKey: '0,0', holderId: aId, epoch: epochA });
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
    b.sendActorMoveBatch(epochA, [REF_ENTRY]); // a player forging actor state
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
    b.sendEvent('ChatSend', { text: 'sfence' });
    await b.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'sfence');
    assert.equal(b.inbox.events.filter((e) => e.name === 'ActorStatsDynamic').length, 0);
  });

  await t.test('far player receives no actor traffic', async () => {
    const c = await TestClient.connect(server.port);
    await c.joinAsNew('Cara');
    await c.waitEvent('PlayerList');
    c.sendCellChange('40,40', 0, 0, 0); // far from 0,0
    await c.waitEvent('PlayerCellChange');
    // No peer covers 40,40, so nothing holds it — a player never gets a grant. The point of
    // the test is unchanged: no actor traffic from 0,0 reaches her.
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
    await a.waitEvent('WorldKillCount'); // the broadcast reaches the peer too

    // Duplicate (same ref+deathNo) -> no relay, no tally bump.
    b.inbox.events.length = 0;
    a.sendEvent('ActorDeath', { cellKey: '0,0', epoch: epochA, ref: ACTOR_REF, killerPlayerId: aId, deathNo: 1, killedRecordId: 'cliffracer' });
    b.sendEvent('ChatSend', { text: 'dfence' });
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
    server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1', ...cfg });

    const d = await TestClient.simPeer(server.port, PEER_PASS, 'Dagoth');
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

// M9 capacity: the holder's payload is byte-identical for every peer, so it is enveloped
// ONCE and the same frame handed to all of them. This is where a sequence mistake would
// show — the client's stale-drop is `seq <= last -> drop` over a cursor SHARED by 0x0101
// and 0x0200, so a repeated or regressing seq on any socket silently mutes both families.
test('shared ActorMoveBatch frame decodes independently for every recipient', async (t) => {
  const server = await startServer({ requireGameData: false,
    dataDir: tmpDataDir(),
    port: 0,
    host: '127.0.0.1',
    configOverride: {
      limits: { maxConnsPerIp: 8 }, // 4 sockets, all from 127.0.0.1
      server: { password: PEER_PASS },
    },
  });
  t.after(() => server.close());

  const holder = await TestClient.simPeer(server.port, PEER_PASS, 'Holder');
  holder.sendCellChange('5,5', 0, 0, 0);
  await holder.waitEvent('PlayerCellChange');
  const grant = await holder.waitEvent('ActorAuthorityGrant');
  const epoch = (grant.value as { epoch: number }).epoch;

  const peers: TestClient[] = [];
  for (const name of ['Peer1', 'Peer2', 'Peer3']) {
    const c = await TestClient.connect(server.port);
    await c.joinAsNew(name);
    await c.waitEvent('PlayerList');
    c.sendCellChange('5,5', 0, 0, 0); // co-located: all in the near LOD tier, none skipped
    await c.waitEvent('PlayerCellChange');
    await c.waitEvent('ActorAuthorityInfo');
    peers.push(c);
  }
  for (const c of peers) c.inbox.actorBatches.length = 0;

  const ROUNDS = 3;
  for (let i = 0; i < ROUNDS; i++) {
    holder.sendActorMoveBatch(epoch, [{ ...REF_ENTRY, pose: { ...REF_ENTRY.pose, x: 100 + i } }]);
  }
  // Read the inbox directly rather than waitActorBatch (which consumes): the whole point is
  // to inspect the full per-socket frame sequence.
  for (const c of peers) await c.waitUntil(() => c.inbox.actorBatches.length >= ROUNDS, '3 actor batches');

  for (const c of peers) {
    const got = c.inbox.actorBatches;
    assert.equal(got.length, ROUNDS, 'every peer got every relayed frame');
    // Independently decodable AND correct: one shared buffer must not mean shared damage.
    got.forEach((f, i) => {
      assert.equal(f.batch.epoch, epoch);
      assert.deepEqual(f.batch.entries, [{ ...REF_ENTRY, pose: { ...REF_ENTRY.pose, x: 100 + i } }]);
    });
    for (let i = 1; i < got.length; i++) {
      assert.ok(got[i]!.seq > got[i - 1]!.seq, `seq must strictly increase per socket: ${got.map((f) => f.seq)}`);
    }
  }
  // Same frame, same seq for all recipients of one relay — that identity is exactly what
  // makes a single serialization reusable, and it is safe because each peer gets one.
  for (let i = 0; i < ROUNDS; i++) {
    const seqs = peers.map((c) => c.inbox.actorBatches[i]!.seq);
    assert.equal(new Set(seqs).size, 1, `one relay -> one seq, got ${seqs}`);
  }

  holder.close();
  for (const c of peers) c.close();
  await holder.closed;
  for (const c of peers) await c.closed;
});

test('an actor leaving a cell is announced to BOTH cells, not just the one it left', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS } } as never });
  t.after(() => server.close());

  const peer = await TestClient.simPeer(server.port, PEER_PASS, 'Holder');
  peer.sendCellChange('0,0', 0, 0, 0);
  // The EPOCH from the grant, not a guess: authCheck refuses an actor event whose epoch does
  // not match the current one, which is the guard that stops a stale holder talking.
  const grant = await peer.waitEvent('ActorAuthorityGrant');
  const epoch = (grant.value as { epoch: number }).epoch;

  const here = await TestClient.connect(server.port);
  await here.joinAsNew('Stayer');
  await here.waitEvent('PlayerList');
  here.sendCellChange('0,0', 0, 0, 0);
  // FAR AWAY, not next door. Relay visibility already covers ADJACENT cells, so a neighbour
  // would receive this anyway and the test would pass with the destination relay deleted --
  // it did, the first time this was written. A travelling companion crosses the map, which is
  // the case that actually needs the second relay.
  const there = await TestClient.connect(server.port);
  await there.joinAsNew('Waiter');
  await there.waitEvent('PlayerList');
  there.sendCellChange('20,20', 0, 0, 0);
  await new Promise((r) => setTimeout(r, 300));

  // A companion travels out of 0,0 and across the map to 20,20.
  peer.sendEvent('ActorCellChange', {
    cellKey: '0,0', epoch, ref: { __refnum: { index: 55, contentFile: 0 } },
    toCellKey: '20,20', x: 10, y: 20, z: 30,
  });

  // BOTH rooms have to hear it, and they are different rooms full of different people: the
  // player left behind must stop drawing the actor where it was, and the player at the
  // destination must have it arrive. Every other actor event concerns ONE cell because the
  // actor is in it; this is the exception by definition -- and relaying it only to the origin
  // is exactly what leaves a travelling companion standing in the old cell forever.
  const a = await here.waitEvent('ActorCellChange');
  const b = await there.waitEvent('ActorCellChange');
  assert.equal((a.value as { toCellKey: string }).toCellKey, '20,20');
  assert.equal((b.value as { toCellKey: string }).toCellKey, '20,20');

  peer.close(); here.close(); there.close();
});
