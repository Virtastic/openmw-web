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

type Pose = { x: number; y: number; z: number };

// The rule server.ts simPeerPass applies: one anchor per distinct occupied cell, carrying a
// player's live position; exteriors and interiors split; chargen cells never anchored.
function anchorsFor(players: { cellKey: string; pose: Pose }[]): {
  anchors: Pose[]; interiors: string[];
} {
  const byCell = new Map<string, Pose>();
  for (const p of players) {
    if (isChargenCell(p.cellKey)) continue;
    if (!byCell.has(p.cellKey)) byCell.set(p.cellKey, p.pose);
  }
  const anchors: Pose[] = [];
  const interiors: string[] = [];
  for (const ck of [...byCell.keys()].sort()) {
    if (parseExterior(ck)) anchors.push(byCell.get(ck)!);
    else interiors.push(ck);
  }
  return { anchors, interiors };
}

const at = (cellKey: string, x: number, y: number, z = 0) => ({ cellKey, pose: { x, y, z } });

// The expiry rule server.ts simPeerPass applies to held anchors (backlog 382): an exterior
// outlives its last human by anchorIdleSec; an interior is dropped the pass its last human
// leaves; the dummy only ever stands in an exterior.
type Held = Map<string, { pose: Pose; until: number }>;
function passFor(held: Held, players: { cellKey: string; pose: Pose }[], now: number, idleMs: number): {
  held: Held; stand: string | undefined;
} {
  for (const p of players) if (!isChargenCell(p.cellKey)) held.set(p.cellKey, { pose: p.pose, until: now + idleMs });
  const occupied = new Set(players.map((p) => p.cellKey));
  for (const [ck, a] of [...held]) if (a.until <= now || (!parseExterior(ck) && !occupied.has(ck))) held.delete(ck);
  const stand = players.find((p) => held.has(p.cellKey) && parseExterior(p.cellKey) !== null)?.cellKey;
  return { held, stand };
}

test('an interior expires the pass its last human leaves; an exterior keeps anchorIdleSec; the dummy stays outdoors', () => {
  const held: Held = new Map();
  const shop = 'balmora, ravirr: trader', club = 'balmora, council club';
  let r = passFor(held, [at(shop, 1, 1), at(club, 2, 2), at('-3,-2', 3, 3)], 0, 60_000);
  assert.deepEqual([...r.held.keys()].sort(), ['-3,-2', club, shop], 'both interiors anchored while occupied');
  assert.equal(r.stand, '-3,-2');

  // The shopper leaves the trader; the walker steps indoors. Next pass, 5 s on.
  r = passFor(held, [at(club, 2, 2), at(club, 4, 4)], 5_000, 60_000);
  assert.deepEqual([...r.held.keys()].sort(), ['-3,-2', club], 'the emptied interior is gone at once; the exterior lingers');
  assert.equal(r.stand, undefined, 'the dummy never stands indoors, even with everyone inside');

  // The exterior outlives its last human by anchorIdleSec, then goes too.
  r = passFor(held, [at(club, 2, 2)], 65_000, 60_000);
  assert.deepEqual([...r.held.keys()], [club]);
});

test('players in the same cell produce one anchor, at a real player position', () => {
  const r = anchorsFor([at('-2,-9', -10350, -71235, 167), at('-2,-9', -10000, -71000, 167)]);
  assert.deepEqual(r.anchors, [{ x: -10350, y: -71235, z: 167 }],
    'the anchor is a live pose, never a computed cell centre');
});

test('players spread across the world each anchor their own region, in ONE list', () => {
  // The case that used to need three engine processes.
  const r = anchorsFor([at('-2,-9', 1, 2), at('3,4', 5, 6), at('-15,2', 7, 8)]);
  assert.equal(r.anchors.length, 3, 'one anchor per region, in one list for one process');
});

test('200 players in 40 places is 40 anchors, in ONE peer', () => {
  const players: { cellKey: string; pose: Pose }[] = [];
  for (let i = 0; i < 40; i++)
    for (let p = 0; p < 5; p++) players.push(at(`${i},0`, i * 8192 + p, 0));
  const r = anchorsFor(players);
  assert.equal(r.anchors.length, 40, 'one anchor per region, not one per player');
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
