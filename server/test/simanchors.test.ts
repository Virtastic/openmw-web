// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// ONE PEER, EVERY OCCUPIED CELL — the thing that makes this scale.
//
// The engine takes a LIST of anchors (Scene::setSimAnchors + the shared nearest-anchor
// reduction in actorutil), so 40 occupied regions live in ONE process: the marginal cost of
// a region is its cells, not a whole second engine. Anchors are WORLD POSITIONS — each
// player's live pose — because a cell-centre anchor covered its own cell but reached only
// ~3072 units into a neighbour against the 7168 processing range, leaving a ring of
// loaded-but-frozen cells.
//
// This pins the server half: one anchor per occupied cell carrying a real position, with
// interiors riding separately by NAME (an interior has no coordinate).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExterior, isChargenCell } from '../src/core/movement';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

type Pose = { x: number; y: number; z: number };

// The rule server.ts simPeerPass applies: one anchor per distinct occupied cell, carrying a
// player's live position; exteriors and interiors split; chargen cells never anchored.
function anchorsFor(players: { cellKey: string; pose: Pose }[]): {
  anchors: Pose[]; interiors: string[];
} {
  // Mirrors server.ts simPeerPass: ONE ANCHOR PER PLAYER outdoors (keyed by cell, the last
  // player won and two at opposite edges of a cell left one of them unsimulated), interiors by
  // name, once each.
  const anchors: Pose[] = [];
  const interiors = new Set<string>();
  for (const p of players) {
    if (isChargenCell(p.cellKey)) continue;
    if (parseExterior(p.cellKey)) anchors.push(p.pose);
    else interiors.add(p.cellKey);
  }
  anchors.sort((p, q) => p.x - q.x || p.y - q.y || p.z - q.z);
  return { anchors, interiors: [...interiors].sort() };
}

const at = (cellKey: string, x: number, y: number, z = 0) => ({ cellKey, pose: { x, y, z } });

// Backlog 382, on the wire: pins server.ts simPeerPass (commit 6ce7b7db) -- an interior anchor
// is dropped the pass its last human leaves (occupied = the humans' cellKeys; before, it
// lingered anchorIdleSec like an exterior), and the dummy's `place` is only ever an exterior
// (before, it stood in whichever cell the first human held, interior included). No engine:
// [simPeer].enabled is flipped after boot with an empty binary, so the supervisor spawns
// nothing and the pass talks to the TestClient peer. A pass is every 5 s.
test('on the wire: two occupied interiors both anchor; one emptied is gone next pass; the dummy stays outdoors', async (t) => {
  const PEER_PASS = 'peer-secret-1';
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS }, limits: { maxConnsPerIp: 16 }, simPeer: { anchorIdleSec: 60 } } });
  t.after(() => server.close());
  server.config.simPeer.enabled = true;
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  const shop = 'balmora, ravirr: trader', club = 'balmora, council club';
  const join = async (name: string, cell: string) => {
    const c = await TestClient.connect(server.port);
    t.after(() => c.close());
    await c.joinAsNew(name);
    await c.waitEvent('PlayerList');
    c.sendCellChange(cell, 1, 1, 0);
    return c;
  };
  type Anchors = { anchors: unknown[]; interiors: string[]; place?: { cellKey: string } };
  const nextPass = async (pred: (a: Anchors) => boolean, what: string) =>
    (await peer.waitEvent('SimAnchors', (v) => pred(v as Anchors), 12_000).catch(() => assert.fail(what))).value as Anchors;

  const shopper = await join('Shopper', shop);
  await join('Drinker', club);
  const walker = await join('Walker', '-3,-2');
  let a = await nextPass((v) => v.interiors.length === 2 && v.anchors.length === 1, 'both interiors never anchored beside the street');
  assert.deepEqual([...a.interiors].sort(), [club, shop]);
  assert.equal(a.place?.cellKey, '-3,-2', 'the dummy stands with the walker, outdoors');

  // The shopper steps out into the street: the trader is gone the very next pass, well
  // inside anchorIdleSec.
  peer.inbox.events.length = 0;
  const t0 = Date.now();
  shopper.sendCellChange('-3,-2', 2, 2, 0);
  a = await nextPass((v) => !v.interiors.includes(shop), 'the emptied interior lingered past a pass');
  assert.ok(Date.now() - t0 < 12_000, 'dropped within the pass after the exit, not after anchorIdleSec');
  assert.deepEqual(a.interiors, [club], 'the still-occupied interior is kept');
  assert.equal(a.place?.cellKey, '-3,-2');

  // Everyone indoors: the street empties into the club. The exterior anchor lingers (idle
  // grace) but nobody stands there, so the dummy is placed nowhere rather than inside the
  // club (a third active interior, pre-fix: the first human's cell, whatever it was).
  peer.inbox.events.length = 0;
  for (const c of [shopper, walker]) c.sendCellChange(club, 3, 3, 0);
  await new Promise((r) => setTimeout(r, 5_500)); // the periodic pass, after both moves landed
  const last = peer.inbox.events.filter((e) => e.name === 'SimAnchors').at(-1)?.value as Anchors | undefined;
  assert.ok(last, 'no pass after everyone went indoors');
  assert.deepEqual(last.interiors, [club]);
  assert.equal(last.anchors.length, 1, 'the street keeps its anchor for anchorIdleSec');
  assert.equal(last.place, undefined, `the dummy stood indoors: ${last.place?.cellKey}`);
});

test('players in the same cell each anchor where they stand, at real player positions', () => {
  const r = anchorsFor([at('-2,-9', -10350, -71235, 167), at('-2,-9', -10000, -71000, 167)]);
  assert.deepEqual(r.anchors, [{ x: -10350, y: -71235, z: 167 }, { x: -10000, y: -71000, z: 167 }],
    'each anchor is a live pose, never a computed cell centre, and nobody shares one');
});

test('players spread across the world each anchor their own region, in ONE list', () => {
  // The case that used to need three engine processes.
  const r = anchorsFor([at('-2,-9', 1, 2), at('3,4', 5, 6), at('-15,2', 7, 8)]);
  assert.equal(r.anchors.length, 3, 'one anchor per region, in one list for one process');
});

test('200 players in 40 places is 200 anchors, in ONE peer', () => {
  const players: { cellKey: string; pose: Pose }[] = [];
  for (let i = 0; i < 40; i++)
    for (let p = 0; p < 5; p++) players.push(at(`${i},0`, i * 8192 + p, 0));
  const r = anchorsFor(players);
  assert.equal(r.anchors.length, 200, 'one anchor per player: a region wider than the processing range needs each');
});

test('interiors ride separately, by NAME — they have no coordinate to anchor on', () => {
  const r = anchorsFor([at('balmora, council club', 1, 2), at('0,0', 3, 4)]);
  assert.deepEqual(r.interiors, ['balmora, council club']);
  assert.deepEqual(r.anchors, [{ x: 3, y: 4, z: 0 }]);
});

test('chargen cells are never anchored — the sanctuary holds', () => {
  const r = anchorsFor([at('imperial prison ship', 0, 0), at('0,0', 1, 1)]);
  assert.deepEqual(r.interiors, [], 'the opening must stay unheld or creation stalls forever');
  assert.equal(r.anchors.length, 1);
});

test('the cell list is stable for an unchanged roster', () => {
  // The derived CELL set is what gates the engine-side grid rebuild; roster order must not
  // churn it.
  const a = anchorsFor([at('3,4', 1, 1), at('-2,-9', 2, 2)]);
  const b = anchorsFor([at('-2,-9', 2, 2), at('3,4', 1, 1)]);
  assert.deepEqual(a, b, 'roster order must not change the anchor list');
});

// ONE ANCHOR PER PLAYER, on the wire. Two players at opposite edges of one cell are further
// apart than the 7168 u processing range; keyed by cell, the peer simulated around only one.
test('on the wire: two players at opposite edges of one cell are two anchors', async (t) => {
  const PEER_PASS = 'peer-secret-2';
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS }, limits: { maxConnsPerIp: 16 } } });
  t.after(() => server.close());
  server.config.simPeer.enabled = true;
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  for (const [name, x, y] of [['West', 100, 100], ['East', 8000, 8000]] as const) {
    const c = await TestClient.connect(server.port);
    t.after(() => c.close());
    await c.joinAsNew(name);
    await c.waitEvent('PlayerList');
    c.sendCellChange('0,0', x, y, 0);
  }
  type Anchors = { anchors: { x: number; y: number }[] };
  const a = (await peer.waitEvent('SimAnchors', (v) => (v as Anchors).anchors.length === 2, 12_000)
    .catch(() => assert.fail('one anchor for two players far apart in one cell'))).value as Anchors;
  const xs = a.anchors.map((p) => Math.round(p.x)).sort((p, q) => p - q);
  assert.deepEqual(xs, [100, 8000], 'each anchor stands where its player stands');
});

// THE 3x3 IS HELD, AND THE OPENING STAYS UNHELD. A player's neighbour cells go to the peer (so
// their NPCs are simulated once and puppeted on every screen); nothing within one cell of
// someone still creating a character does.
test('on the wire: the peer holds the 3x3 around a player, but nothing next to a player in chargen', async (t) => {
  const PEER_PASS = 'peer-secret-3';
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS }, limits: { maxConnsPerIp: 16 } } });
  t.after(() => server.close());
  server.config.simPeer.enabled = true;
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  const join = async (name: string, cell: string) => {
    const c = await TestClient.connect(server.port);
    t.after(() => c.close());
    const w = await c.joinAsNew(name);
    await c.waitEvent('PlayerList');
    c.sendCellChange(cell, 10, 10, 0);
    return w['playerId'] as number;
  };
  const newbie = await join('Newbie', '-2,-9');
  server.roster.get(newbie)!.inChargen = true;
  await join('Veteran', '5,5');
  const granted = new Set<string>();
  const until = Date.now() + 12_000;
  while (Date.now() < until && granted.size < 9) {
    for (const e of peer.inbox.events) if (e.name === 'ActorAuthorityGrant') granted.add((e.value as { cellKey: string }).cellKey);
    await new Promise((r) => setTimeout(r, 100));
  }
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    assert.ok(granted.has(`${5 + dx},${5 + dy}`), `the veteran's neighbour ${5 + dx},${5 + dy} was not held`);
  }
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    assert.ok(!granted.has(`${-2 + dx},${-9 + dy}`), `held next to a player in chargen: ${-2 + dx},${-9 + dy}`);
  }
});
