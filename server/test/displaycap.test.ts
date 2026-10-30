// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-197: with 100 bots in one hub, each client is sent at most the display cap of other
// players, party members always included; the cap is off at 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MoveBroadcaster, type InterestSettings } from '../src/core/movement';
import { Roster, type Peer, type Player } from '../src/core/players';
import { resetMetrics, metrics } from '../src/metrics';

const peer = (): Peer => ({ sendEvent: () => undefined, sendBinary: () => true, sendBinaryFrame: () => true, disconnect: () => undefined });

function hub(n: number): { roster: Roster; players: Player[] } {
  const roster = new Roster();
  const players: Player[] = [];
  for (let i = 0; i < n; i++) {
    const p = roster.addAuthed(`P${i}`, `p${i}`, 0, peer());
    roster.joinWorld(p);
    p.cellKey = '-2,-9'; // Seyda Neen
    // Spread on a line so "nearest" is well defined: player i stands at x = i * 100.
    p.pose = { x: i * 100, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0, animVel: 0, counter: 0 };
    p.poseVersion = 1;
    players.push(p);
  }
  return { roster, players };
}

const settings = (maxVisible: number): InterestSettings => ({
  cull: false, enterR2: 0, exitR2: 0, minPeers: 0, maxVisible,
  nearR2: Infinity, midR2: Infinity, nearStride: 1, midStride: 1, farStride: 1,
});

const viewOf = (b: MoveBroadcaster, id: number): Map<number, unknown> =>
  (b as unknown as { perRecipient: Map<number, Map<number, unknown>> }).perRecipient.get(id)!;

test('100 players in one hub: every client is sent at most the cap, nearest first', () => {
  resetMetrics();
  const { roster, players } = hub(100);
  const b = new MoveBroadcaster(roster, undefined, settings(30));
  b.tick();
  for (const p of players) assert.ok(viewOf(b, p.id).size <= 30, `${p.name} sees ${viewOf(b, p.id).size}`);
  // The player at one end sees exactly its 30 nearest neighbours.
  const first = viewOf(b, players[0]!.id);
  assert.equal(first.size, 30);
  for (let i = 1; i <= 30; i++) assert.ok(first.has(players[i]!.id), `P0 should see its neighbour P${i}`);
  assert.equal(first.has(players[99]!.id), false);
  assert.ok((metrics.displayCapped.get({}) ?? 0) >= 100 * 69, 'withheld views are counted');
});

test('party members are always included, even past the cap and far away', () => {
  const { roster, players } = hub(100);
  const me = players[0]!;
  const mates = new Set([players[99]!.id, players[98]!.id]);
  const b = new MoveBroadcaster(roster, undefined, settings(10),
    (r, s) => r.id === me.id && mates.has(s.id));
  b.tick();
  const seen = viewOf(b, me.id);
  assert.equal(seen.size, 10);
  for (const id of mates) assert.ok(seen.has(id), 'a party mate is never cut');
  for (let i = 1; i <= 8; i++) assert.ok(seen.has(players[i]!.id), 'the rest of the slots go to the nearest');
});

test('a cap of 0 sends everyone in the cell (the old behaviour)', () => {
  const { roster, players } = hub(100);
  const b = new MoveBroadcaster(roster, undefined, settings(0));
  b.tick();
  assert.equal(viewOf(b, players[0]!.id).size, 99);
});

test('a player cut by the cap is despawned for that client and re-sighted when a slot frees', () => {
  const { roster, players } = hub(12);
  const me = players[0]!;
  const b = new MoveBroadcaster(roster, undefined, settings(5));
  b.tick();
  assert.equal(viewOf(b, me.id).has(players[8]!.id), false);
  // Nearer players leave: P8 is now within the nearest five.
  for (let i = 1; i <= 6; i++) roster.remove(players[i]!);
  b.tick();
  assert.equal(viewOf(b, me.id).has(players[8]!.id), true);
});
