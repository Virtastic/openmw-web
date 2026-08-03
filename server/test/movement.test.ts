// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M1 movement: codec golden vectors, quantization bounds, visibility matrix, and the
// live relay pipeline (stale-drop, batches, cell bubbles, budget) over real ws clients.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  packMove,
  unpackMove,
  packMoveBatch,
  unpackMoveBatch,
  quantYaw,
  unquantYaw,
  quantPitch,
  unquantPitch,
  quantAnimVel,
  unquantAnimVel,
  type PlayerPose,
  type BatchEntry,
} from '../src/proto/movement';
import { cellsVisible, MoveBroadcaster, interestFromLimits, type InterestSettings } from '../src/core/movement';
import { ProtoError, unpackEnvelope, MSG_PLAYER_MOVE_BATCH } from '../src/proto/envelope';
import { startServer } from '../src/server';
import type { Player, Roster } from '../src/core/players';
import type { Config } from '../src/config';
import { TestClient, tmpDataDir } from './helpers';

const POSE: PlayerPose = { x: 1.5, y: -2, z: 3, yaw: 0x1234, pitch: 0x40, flags: 0b010101, animVel: 200, counter: 0 };

test('movement codec golden vectors', () => {
  // Hand-computed: f32 LE 1.5 = 00 00 C0 3F, -2 = 00 00 00 C0, 3 = 00 00 40 40,
  // yaw 0x1234 LE = 34 12, pitch 40, flags 15, animVel C8, counter 00, 2 reserved zero
  // bytes pad the field list (18 B) to the specced 20-byte payload.
  const expected = Buffer.from([
    0x00, 0x00, 0xc0, 0x3f,
    0x00, 0x00, 0x00, 0xc0,
    0x00, 0x00, 0x40, 0x40,
    0x34, 0x12,
    0x40, 0x15, 0xc8, 0x00,
    0x00, 0x00,
  ]);
  assert.deepEqual([...packMove(POSE)], [...expected]);
  assert.deepEqual(unpackMove(expected), POSE);

  const batch = packMoveBatch([{ id: 0xbeef, pose: POSE }]);
  assert.deepEqual([...batch.subarray(0, 3)], [0x01, 0xef, 0xbe]); // count, id LE
  assert.deepEqual([...batch.subarray(3)], [...expected]);
  assert.deepEqual(unpackMoveBatch(batch), [{ id: 0xbeef, pose: POSE }]);
  assert.deepEqual(unpackMoveBatch(Buffer.from([0x00])), []);

  assert.throws(() => unpackMove(Buffer.alloc(19)), ProtoError);
  assert.throws(() => unpackMove(Buffer.alloc(21)), ProtoError);
  assert.throws(() => unpackMoveBatch(Buffer.from([0x02, 0x01, 0x00])), ProtoError); // count lies
  assert.throws(() => unpackMoveBatch(Buffer.alloc(0)), ProtoError);
});

test('quantization round-trips within step bounds and clamps', () => {
  const TWO_PI = Math.PI * 2;
  for (const yaw of [0, 0.001, 1, Math.PI, TWO_PI - 0.001, TWO_PI, 7.5, -1]) {
    const norm = ((yaw % TWO_PI) + TWO_PI) % TWO_PI;
    const back = unquantYaw(quantYaw(yaw));
    const diff = Math.min(Math.abs(back - norm), TWO_PI - Math.abs(back - norm)); // wrap-aware
    assert.ok(diff <= TWO_PI / 65536, `yaw ${yaw}: diff ${diff}`);
  }
  assert.equal(quantYaw(TWO_PI), 0); // wraps, not clamps
  assert.equal(quantYaw(Math.PI), 32768);

  for (const pitch of [-Math.PI / 2, -0.5, 0, 0.5, Math.PI / 2]) {
    assert.ok(Math.abs(unquantPitch(quantPitch(pitch)) - pitch) <= Math.PI / 255);
  }
  assert.equal(quantPitch(10), 255); // clamped high
  assert.equal(quantPitch(-10), 0); // clamped low

  assert.equal(quantAnimVel(-1), 0);
  assert.equal(quantAnimVel(5), 255); // clamped at 2x
  assert.equal(quantAnimVel(2), 255);
  for (const v of [0, 0.33, 1, 1.99, 2]) {
    assert.ok(Math.abs(unquantAnimVel(quantAnimVel(v)) - v) <= 2 / 255);
  }
});

test('visibility matrix', () => {
  // Interiors: exact same key only.
  assert.equal(cellsVisible('balmora, south wall cornerclub', 'balmora, south wall cornerclub'), true);
  assert.equal(cellsVisible('balmora, south wall cornerclub', 'balmora, eight plates'), false);
  // Exterior adjacency (Chebyshev <= 1), including negatives.
  assert.equal(cellsVisible('0,0', '0,0'), true);
  assert.equal(cellsVisible('0,0', '1,1'), true);
  assert.equal(cellsVisible('-1,0', '0,0'), true);
  assert.equal(cellsVisible('-1,-1', '0,0'), true);
  assert.equal(cellsVisible('-2,0', '-1,1'), true);
  assert.equal(cellsVisible('0,0', '2,0'), false);
  assert.equal(cellsVisible('0,0', '0,-2'), false);
  assert.equal(cellsVisible('-3,9', '4,-2'), false);
  // Interior vs exterior never match.
  assert.equal(cellsVisible('0,0', 'some cave'), false);
  // Unknown cell -> visible to nobody.
  assert.equal(cellsVisible(undefined, '0,0'), false);
  assert.equal(cellsVisible('0,0', undefined), false);
  assert.equal(cellsVisible(undefined, undefined), false);
});

test('movement relay over real clients', async (t) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  const { playerId: aId } = await a.joinAsNew('Alice');
  await a.waitEvent('PlayerList');
  const b = await TestClient.connect(server.port);
  const { playerId: bId } = await b.joinAsNew('Bob');
  await b.waitEvent('PlayerList');

  await t.test('PlayerCellChange relays to everyone with id added', async () => {
    a.sendCellChange('3,-2', 100, 200, 300);
    const seenByB = await b.waitEvent('PlayerCellChange');
    assert.deepEqual(seenByB.value, { id: aId, cellKey: '3,-2', x: 100, y: 200, z: 300 });
    const seenByA = await a.waitEvent('PlayerCellChange'); // relay includes the sender
    assert.deepEqual(seenByA.value, { id: aId, cellKey: '3,-2', x: 100, y: 200, z: 300 });
  });

  await t.test('adjacent-cell pose reaches the peer within 200ms', async () => {
    b.sendCellChange('4,-2', 0, 0, 0); // Chebyshev 1 from a's "3,-2"
    await a.waitEvent('PlayerCellChange');
    await b.waitEvent('PlayerCellChange');
    // Mutual visibility just began: each side gets the other's synthesized pose
    // force-included. Drain both before timing the real move.
    await a.waitBatch((batch) => batch.entries.some((e) => e.id === bId));
    await b.waitBatch((batch) => batch.entries.some((e) => e.id === aId));

    const sent = Date.now();
    a.sendMove({ x: 123.5, y: -7, z: 42, yaw: 1000, pitch: 200, flags: 0b1, animVel: 90 });
    const batch = await b.waitBatch((x) => x.entries.some((e) => e.id === aId));
    assert.ok(Date.now() - sent <= 200, `batch took ${Date.now() - sent}ms`);
    const entry = batch.entries.find((e) => e.id === aId)!;
    assert.deepEqual(entry.pose, { x: 123.5, y: -7, z: 42, yaw: 1000, pitch: 200, flags: 1, animVel: 90, counter: 0 });
  });

  await t.test('stale seq is dropped', async () => {
    a.sendMove({ x: 999, y: 0, z: 0 }, 1); // seq far below a's current counter
    // The fresh move after it must be the next thing b sees from a — never x=999.
    a.sendMove({ x: 55, y: 0, z: 0 });
    const batch = await b.waitBatch((x) => x.entries.some((e) => e.id === aId));
    assert.equal(batch.entries.find((e) => e.id === aId)!.pose.x, 55);
    assert.ok(!b.inbox.batches.some((x) => x.entries.some((e) => e.id === aId && e.pose.x === 999)));
  });

  await t.test('far cell gets no batches; return force-includes latest pose', async () => {
    b.sendCellChange('20,20', 0, 0, 0);
    await b.waitEvent('PlayerCellChange');
    b.inbox.batches.length = 0;
    a.sendMove({ x: 777, y: 1, z: 1 });
    await new Promise((r) => setTimeout(r, 300)); // >4 ticks
    assert.equal(b.inbox.batches.filter((x) => x.entries.some((e) => e.id === aId)).length, 0);

    // Coming back adjacent force-includes a's current pose without a re-sending.
    b.sendCellChange('3,-1', 0, 0, 0);
    const batch = await b.waitBatch((x) => x.entries.some((e) => e.id === aId));
    assert.equal(batch.entries.find((e) => e.id === aId)!.pose.x, 777);
  });

  await t.test('/status exposes cellKey per player', async () => {
    const status = (await (await fetch(`http://127.0.0.1:${server.port}/status`)).json()) as {
      players: { id: number; cellKey: string | null }[];
    };
    assert.equal(status.players.find((p) => p.id === aId)?.cellKey, '3,-2');
    assert.equal(status.players.find((p) => p.id === bId)?.cellKey, '3,-1');
  });

  await t.test('out-of-bounds and non-finite moves are ignored', async () => {
    a.sendMove({ x: 600000, y: 0, z: 0 });
    a.sendMove({ x: Number.NaN, y: 0, z: 0 });
    a.sendMove({ x: 11, y: 0, z: 0 });
    const batch = await b.waitBatch((x) => x.entries.some((e) => e.id === aId));
    assert.equal(batch.entries.find((e) => e.id === aId)!.pose.x, 11);
  });

  a.close();
  b.close();
  await a.closed;
  await b.closed;
});

// Was a kick; movement now SHEDS (see backpressure.test.ts). Kicking a player for a burst
// of self-correcting absolute poses cost more than the frames it saved.
test('movement budget shed', async (t) => {
  const server = await startServer({ requireGameData: false,
    dataDir: tmpDataDir(),
    port: 0,
    host: '127.0.0.1',
    configOverride: { limits: { moveMsgsPerSec: 5 } },
  });
  t.after(() => server.close());

  const c = await TestClient.connect(server.port);
  await c.joinAsNew('Speedy');
  await c.waitEvent('PlayerList');
  c.sendCellChange('0,0');
  await c.waitEvent('PlayerCellChange');
  // General msg budget (60/s) untouched; the move budget (5) trips on a flood — the excess
  // frames are dropped and the session lives.
  for (let i = 0; i < 40 && !c.isClosed; i++) c.sendMove({ x: i, y: 0, z: 0 });
  c.sendJson({ t: 'SessionPing', clientTime: 1 });
  await c.waitJson('SessionPong');
  assert.equal(c.isClosed, false);
  c.close();
  await c.closed;
});

// --------------------------------------------------- broadcaster unit harness

// Minimal fake roster/peers to observe exactly what each tick emits, per recipient.
// Records DECODED frames (envelope + entries) so seq handling is observable too.
interface Recv {
  frames: { seq: number; entries: BatchEntry[] }[];
  events: { name: string; body: { id?: number } }[];
}

function harness(settings?: InterestSettings) {
  const players: Player[] = [];
  const recv = new Map<number, Recv>();
  const add = (id: number, cellKey: string | undefined, x = 0, pose = true): Player => {
    const r: Recv = { frames: [], events: [] };
    recv.set(id, r);
    const p = {
      id,
      name: `p${id}`,
      accountKey: `p${id}`,
      rank: 0,
      inWorld: true,
      cellKey,
      pose: pose ? { x, y: 0, z: 0, yaw: 0, pitch: 128, flags: 0, animVel: 0, counter: 0 } : undefined,
      moveSeq: 0,
      poseVersion: 1,
      peer: {
        sendEvent: (name: string, body: { id?: number }) => void r.events.push({ name, body }),
        sendBinary: () => true,
        // Returns true = "delivered". The broadcaster only commits its per-recipient
        // seen-version map when the send actually lands, so a fake returning void would
        // silently model a permanently-shedding client.
        sendBinaryFrame: (type: number, frame: Buffer) => {
          assert.equal(type, MSG_PLAYER_MOVE_BATCH);
          const env = unpackEnvelope(frame);
          assert.equal(env.type, MSG_PLAYER_MOVE_BATCH);
          r.frames.push({ seq: env.seq, entries: unpackMoveBatch(env.payload) });
          return true;
        },
        disconnect: () => {},
      },
    } as unknown as Player;
    players.push(p);
    return p;
  };
  const bc = new MoveBroadcaster({ inWorld: () => players } as unknown as Roster, 1_000_000, settings);
  // Moving bumps poseVersion, exactly as the live PlayerMove path does.
  const moveTo = (p: Player, x: number): void => {
    p.pose = { ...p.pose!, x };
    p.poseVersion++;
  };
  // Count entries a recipient received naming `senderId` (i.e. pose updates it must apply).
  const updates = (recipient: number, senderId: number): number =>
    recv.get(recipient)!.frames.filter((f) => f.entries.some((e) => e.id === senderId)).length;
  const leaves = (recipient: number, senderId: number): number =>
    recv.get(recipient)!.events.filter((e) => e.name === 'PlayerLeaveView' && e.body.id === senderId).length;
  return { add, bc, recv, moveTo, updates, leaves };
}

// interestFromLimits only reads these eight keys; the cast keeps the test from restating
// the whole limits table.
function settings(over: Partial<Config['limits']>): InterestSettings {
  return interestFromLimits(
    {
      interestRadius: 0,
      interestHysteresis: 0,
      interestMinPeers: 0,
      lodNearRadius: Infinity,
      lodMidRadius: Infinity,
      lodNearHz: 15,
      lodMidHz: 15,
      lodFarHz: 15,
      ...over,
    } as Config['limits'],
    66,
  );
}

test('broadcaster unit: no empty batches, per-recipient dirty tracking', () => {
  const h = harness();
  const p1 = h.add(1, '0,0');
  const p2 = h.add(2, '1,0');

  h.bc.tick(); // both visible, both dirty -> one batch each
  assert.equal(h.recv.get(1)!.frames.length, 1);
  assert.equal(h.recv.get(2)!.frames.length, 1);
  assert.deepEqual(h.recv.get(1)!.frames[0]!.entries.map((e) => e.id), [2]);

  h.bc.tick(); // nothing changed -> no frames at all
  assert.equal(h.recv.get(1)!.frames.length, 1);
  assert.equal(h.recv.get(2)!.frames.length, 1);

  p1.poseVersion++; // only p1 moved -> only p2 gets a batch
  h.bc.tick();
  assert.equal(h.recv.get(1)!.frames.length, 1);
  assert.equal(h.recv.get(2)!.frames.length, 2);
  void p2;
});

test('interest management: beyond the radius is culled, inside is not', () => {
  // Radius 1000, no hysteresis band, no nearest-K floor, no LOD striding: isolates the cull.
  const h = harness(settings({ interestRadius: 1000, lodNearRadius: 1000, lodMidRadius: 1000 }));
  h.add(1, '0,0', 0); // recipient at the origin
  h.add(2, '0,0', 500); // inside
  h.add(3, '0,0', 5000); // beyond

  for (let i = 0; i < 5; i++) h.bc.tick();
  assert.ok(h.updates(1, 2) >= 1, 'the near peer must be relayed');
  assert.equal(h.updates(1, 3), 0, 'the far peer must never appear in a batch');
  // The cull is DISTANCE, not cell: 3 is still cell-visible, and still sees 1 (who is
  // within 5000 of nobody... 1 is 5000 away from 3 too, so 3 sees only 2 at 4500 -> also
  // culled). Assert the symmetry rather than assuming it.
  assert.equal(h.updates(3, 1), 0);
});

test('interest management: nearest-K floor holds when everyone is beyond the radius', () => {
  // Radius 100 puts every peer outside; the floor of 2 must still deliver the two nearest.
  const h = harness(settings({ interestRadius: 100, interestMinPeers: 2, lodNearRadius: 100, lodMidRadius: 100 }));
  h.add(1, '0,0', 0);
  h.add(2, '0,0', 500);
  h.add(3, '0,0', 1000);
  h.add(4, '0,0', 9000);

  for (let i = 0; i < 3; i++) h.bc.tick();
  assert.ok(h.updates(1, 2) >= 1, 'nearest peer is floored in');
  assert.ok(h.updates(1, 3) >= 1, 'second-nearest peer is floored in');
  assert.equal(h.updates(1, 4), 0, 'the third-nearest is beyond the floor and stays culled');
  // Exactly K, not "K or more": the floor is a minimum, not a bypass of the radius.
  const seen = new Set(h.recv.get(1)!.frames.flatMap((f) => f.entries.map((e) => e.id)));
  assert.deepEqual([...seen].sort(), [2, 3]);
});

test('interest management: hysteresis stops boundary flapping', () => {
  // Enter within 1000, leave only past 1200.
  const h = harness(settings({ interestRadius: 1000, interestHysteresis: 200, lodNearRadius: 1000, lodMidRadius: 1000 }));
  h.add(1, '0,0', 0);
  const far = h.add(2, '0,0', 900);

  h.bc.tick(); // 900 <= 1000 -> enters view
  assert.equal(h.updates(1, 2), 1);

  // Oscillate across the ENTER threshold but inside the exit band. A single-threshold
  // implementation would despawn/respawn on every crossing; assert the pattern, not the
  // end state.
  for (let i = 0; i < 6; i++) {
    h.moveTo(far, 1100); // > enter (1000), <= exit (1200): must STAY in view
    h.bc.tick();
    h.moveTo(far, 900);
    h.bc.tick();
  }
  assert.equal(h.leaves(1, 2), 0, 'no leave-view may fire while inside the exit band');
  assert.equal(h.updates(1, 2), 13, 'every move is relayed: 1 entry + 12 oscillation steps');

  // Past the exit threshold: exactly one leave.
  h.moveTo(far, 1300);
  h.bc.tick();
  assert.equal(h.leaves(1, 2), 1);

  // Asymmetry: back inside the EXIT band is not enough to re-enter — it must reach ENTER.
  h.moveTo(far, 1100);
  h.bc.tick();
  h.bc.tick();
  assert.equal(h.updates(1, 2), 13, 'still culled between the two thresholds');
  assert.equal(h.leaves(1, 2), 1, 'and no repeat leave signal while it stays out');

  h.moveTo(far, 900);
  h.bc.tick();
  assert.equal(h.updates(1, 2), 14, 're-enters once back within the enter radius');
});

test('interest management: crossing INTO the radius force-sends a pose', () => {
  const h = harness(settings({ interestRadius: 1000, lodNearRadius: 1000, lodMidRadius: 1000 }));
  h.add(1, '0,0', 0);
  const p2 = h.add(2, '0,0', 500);

  h.bc.tick();
  assert.equal(h.updates(1, 2), 1); // poseVersion 1 delivered

  // Leave and return WITHOUT bumping poseVersion (a teleport the recipient never saw).
  // Pure version-diffing would consider v1 already delivered and send nothing, leaving the
  // peer with no puppet at all. The force-include must not depend on the pose changing.
  p2.pose = { ...p2.pose!, x: 9000 };
  h.bc.tick();
  assert.equal(h.leaves(1, 2), 1);

  p2.pose = { ...p2.pose!, x: 500 };
  assert.equal(p2.poseVersion, 1, 'guard: the version is deliberately unchanged');
  h.bc.tick();
  assert.equal(h.updates(1, 2), 2, 're-entry force-sends despite an unchanged poseVersion');
  assert.equal(h.recv.get(1)!.frames.at(-1)!.entries.find((e) => e.id === 2)!.pose.x, 500);
});

test('leave-view fires once, only for peers that actually got a pose', () => {
  const h = harness(settings({ interestRadius: 1000, lodNearRadius: 1000, lodMidRadius: 1000 }));
  h.add(1, '0,0', 0);
  const p2 = h.add(2, '0,0', 500);
  const p3 = h.add(3, '0,0', 500, false); // in view, but has no pose yet -> nothing relayed

  h.bc.tick();
  assert.equal(h.updates(1, 2), 1);
  assert.equal(h.updates(1, 3), 0);

  // Both leave the recipient's view on the same tick.
  p2.pose = { ...p2.pose!, x: 9000 };
  p3.cellKey = '9,9';
  h.bc.tick();
  const evs = h.recv.get(1)!.events.filter((e) => e.name === 'PlayerLeaveView');
  // Client contract: body is exactly {id}, and NOTHING is sent for a peer whose pose never
  // reached this client (no puppet was ever spawned there, so a despawn would be noise).
  assert.deepEqual(evs, [{ name: 'PlayerLeaveView', body: { id: 2 } }]);

  // Idempotence is the client's job, but the server must not spam: still exactly one after
  // many further ticks with the peer still out of view.
  for (let i = 0; i < 10; i++) h.bc.tick();
  assert.equal(h.leaves(1, 2), 1);
});

test('LOD: a distant player yields strictly fewer updates than a near one', () => {
  // Culling off so this measures RATE alone. 15/5/1 Hz on a 66 ms tick -> every 1st/3rd/15th.
  const h = harness(settings({
    interestRadius: 0,
    lodNearRadius: 1000,
    lodMidRadius: 3000,
    lodNearHz: 15,
    lodMidHz: 5,
    lodFarHz: 1,
  }));
  h.add(1, '0,0', 0);
  const near = h.add(2, '0,0', 500);
  const mid = h.add(3, '0,0', 2000);
  const far = h.add(4, '0,0', 8000);

  // Everyone moves every tick, so the only thing limiting delivery is the tier stride.
  const TICKS = 60;
  for (let i = 0; i < TICKS; i++) {
    for (const p of [near, mid, far]) p.pose = { ...p.pose!, x: p.pose!.x + 0.01 };
    for (const p of [near, mid, far]) p.poseVersion++;
    h.bc.tick();
  }
  const n = h.updates(1, 2);
  const m = h.updates(1, 3);
  const f = h.updates(1, 4);
  assert.equal(n, TICKS, 'the near tier is every tick');
  assert.ok(m < n && f < m, `tiers must be strictly ordered, got near=${n} mid=${m} far=${f}`);
  // And they must land near the CONFIGURED rates, not merely be ordered: a stride bug that
  // made mid == far would still satisfy a pure ordering assertion.
  assert.ok(Math.abs(m - TICKS / 3) <= 2, `mid ~= 1/3 of ticks, got ${m}`);
  assert.ok(Math.abs(f - TICKS / 15) <= 2, `far ~= 1/15 of ticks, got ${f}`);
  // Nobody is culled: every tier still gets a live stream.
  assert.ok(f >= 1);
  assert.equal(h.leaves(1, 4), 0);
});

test('shared serialization: every recipient decodes its own frame, seq strictly increasing', () => {
  const h = harness();
  const p1 = h.add(1, '0,0', 10);
  const p2 = h.add(2, '0,0', 20);
  const p3 = h.add(3, '0,0', 30);

  const TICKS = 4;
  // Snapshot what each sender's pose was on each tick: a frame captured at tick k must
  // carry tick k's coordinates, not whatever the sender holds now.
  const expected: Record<number, number>[] = [];
  for (let i = 0; i < TICKS; i++) {
    for (const p of [p1, p2, p3]) {
      p.pose = { ...p.pose!, x: p.pose!.x + 1 };
      p.poseVersion++;
    }
    expected.push({ 1: p1.pose!.x, 2: p2.pose!.x, 3: p3.pose!.x });
    h.bc.tick();
  }

  for (const id of [1, 2, 3]) {
    const frames = h.recv.get(id)!.frames;
    // Everyone moved on every tick, so every recipient owes exactly one frame per tick.
    assert.equal(frames.length, TICKS, `recipient ${id} got ${frames.length} frames`);
    // Independently decodable and CORRECT: each recipient sees the other two, never itself,
    // with that tick's real coordinates. A shared-buffer bug shows up here as cross-talk.
    frames.forEach((f, k) => {
      assert.deepEqual(f.entries.map((e) => e.id).sort(), [1, 2, 3].filter((x) => x !== id));
      for (const e of f.entries) assert.equal(e.pose.x, expected[k]![e.id]);
    });
    // The client's stale-drop is `seq <= last -> drop`, so a repeated or regressing seq on
    // one socket would silently mute that player's movement.
    const seqs = frames.map((f) => f.seq);
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i]! > seqs[i - 1]!, `recipient ${id} seq ${seqs}`);
  }
  // Recipients of the SAME tick share one seq — that is what makes one serialized frame
  // reusable across peers, and it is safe precisely because each gets at most one per tick.
  assert.equal(h.recv.get(1)!.frames[0]!.seq, h.recv.get(2)!.frames[0]!.seq);
  assert.equal(h.recv.get(2)!.frames[0]!.seq, h.recv.get(3)!.frames[0]!.seq);
});

// ---------------------------------------------------------------- spatial index (G1)
//
// The index replaced a full N x N roster scan. Two things have to hold, and they pull in
// opposite directions: it must examine strictly less, while still delivering EXACTLY what
// the old scan delivered. Testing only the first would pass trivially by dropping peers —
// the failure mode here is silent invisibility, which no convergence check would catch.

// Deterministic PRNG: a randomized population is the point (hand-picked layouts test the
// cases I already thought of), but a seed makes a failure reproducible.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

test('spatial index: delivers exactly what a brute-force cellsVisible scan would', () => {
  const rand = lcg(0xc0ffee);
  const h = harness(); // no settings = culling off, near tier: pure visibility, no LOD
  const cells: (string | undefined)[] = [];
  for (let i = 0; i < 60; i++) {
    const r = rand();
    // A spread of exteriors (so adjacency actually bites), two interiors that must stay
    // cell-granular, and unplaced players that are visible to nobody.
    if (r < 0.75) cells.push(`${Math.floor(rand() * 5) - 2},${Math.floor(rand() * 5) - 2}`);
    else if (r < 0.92) cells.push(rand() < 0.5 ? 'Balmora, Guild of Fighters' : 'Vivec, Foreign Quarter')
    else cells.push(undefined);
  }
  cells.forEach((c, i) => h.add(i + 1, c, i * 3));

  h.bc.tick();

  for (let i = 0; i < cells.length; i++) {
    const id = i + 1;
    const expected = cells
      .map((c, j) => ({ id: j + 1, cell: c }))
      .filter((s) => s.id !== id && cellsVisible(cells[i], s.cell))
      .map((s) => s.id)
      .sort((a, b) => a - b);
    const frames = h.recv.get(id)!.frames;
    const got = frames.length === 0 ? [] : frames[0]!.entries.map((e) => e.id).sort((a, b) => a - b);
    assert.deepEqual(got, expected, `recipient ${id} in ${String(cells[i])}`);
  }
});

test('spatial index: per-recipient work depends on LOCAL density, not world population', () => {
  // Same local neighbourhood in both worlds; the second adds 200 players who are nowhere
  // near it. Under the old full-roster scan the second number was ~10x the first, which is
  // precisely the cost that made one world of 100+ untenable.
  const perRecipient = (distantPlayers: number): number => {
    const h = harness();
    let id = 1;
    for (let i = 0; i < 20; i++) h.add(id++, '0,0', i * 10); // the crowd under test
    // Spread far away, >1 cell apart from the crowd AND from each other's relevance.
    for (let i = 0; i < distantPlayers; i++) h.add(id++, `${50 + (i % 40) * 3},${Math.floor(i / 40) * 3}`, 0);
    h.bc.tick();
    return h.bc.pairsExamined / (id - 1);
  };

  const small = perRecipient(0);
  const large = perRecipient(200);
  // 20 co-located players examine 20 candidates each (own bucket, self included and skipped
  // in the loop). Distant players examine only their own sparse buckets, so the average can
  // only FALL as they are added — what must not happen is it climbing with population.
  assert.equal(small, 20);
  assert.ok(large <= small, `per-recipient work grew with world population: ${small} -> ${large}`);
});

// The exact shape s10 and s20 exercise and the existing relay test does not: two players in
// the SAME cell at the SAME coordinates, neither of whom ever moves. Their puppets exist
// only because the server force-includes a never-moving player's synthesised pose on first
// visibility; a stationary player never bumps poseVersion again, so if that one send is
// missed there is no second chance and the two never see each other.
test('two stationary players in one cell each receive the other', async (t) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  const { playerId: aId } = await a.joinAsNew('StillA');
  await a.waitEvent('PlayerList');
  const b = await TestClient.connect(server.port);
  const { playerId: bId } = await b.joinAsNew('StillB');
  await b.waitEvent('PlayerList');

  // Identical cell AND identical position — the shared-spawn case.
  a.sendCellChange('7,7', 500, 500, 100);
  b.sendCellChange('7,7', 500, 500, 100);
  await a.waitEvent('PlayerCellChange');
  await b.waitEvent('PlayerCellChange');

  // Neither client sends a single PlayerMove after this point.
  const gotB = await b.waitBatch((x) => x.entries.some((e) => e.id === aId), 5000);
  assert.ok(gotB.entries.some((e) => e.id === aId), 'B never received a pose for stationary A');
  const gotA = await a.waitBatch((x) => x.entries.some((e) => e.id === bId), 5000);
  assert.ok(gotA.entries.some((e) => e.id === bId), 'A never received a pose for stationary B');
});

// The REAL browser ordering, which the test above does not reproduce: A joins and sends its
// cell change while B is still connecting, so B is not in the world to receive that relay.
// B's puppet of A can then only come from a force-included pose in a move batch. This is
// the exact shape of the s10/s20 failures, where A always sees B and B never sees A.
test('a player who joins AFTER someone already settled still receives their pose', async (t) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  const { playerId: aId } = await a.joinAsNew('EarlyA');
  await a.waitEvent('PlayerList');
  a.sendCellChange('9,9', 1000, 1000, 100);
  await a.waitEvent('PlayerCellChange');
  // A now stands still forever. Nothing it does after this point will bump poseVersion.

  const b = await TestClient.connect(server.port);
  await b.joinAsNew('LateB');
  await b.waitEvent('PlayerList');
  b.sendCellChange('9,9', 1000, 1000, 100);
  await b.waitEvent('PlayerCellChange');

  const got = await b.waitBatch((x) => x.entries.some((e) => e.id === aId), 5000);
  assert.ok(got.entries.some((e) => e.id === aId),
    'a late joiner never received the pose of a player who was already standing there');
});
