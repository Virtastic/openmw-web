// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-77 / 202 / 203 / 205 / 135: region ownership, per-region SimAnchors, anchor-send diffing,
// the warm-spare promotion, and the per-region SimReady scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  RegionMap, parseRegionDefs, partitionAnchors, AnchorSender, ANCHOR_DRIFT_UNITS, ANCHOR_HEARTBEAT_MS,
} from '../src/peers/regions';
import { SimPeerSupervisor, type SimPeerSettings } from '../src/core/simpeer';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const TWO_CFG = [
  { id: 'west', rects: [[-100, -100, -1, 100]] },
  { id: 'east', rects: [[0, -100, 100, 100]] },
];
const TWO = [
  { id: 'west', rects: [{ x0: -100, y0: -100, x1: -1, y1: 100 }] },
  { id: 'east', rects: [{ x0: 0, y0: -100, x1: 100, y1: 100 }] },
];

test('no regions configured: one region "world" owns every cell, exterior or interior', () => {
  const m = new RegionMap();
  assert.deepEqual(m.ids, ['world']);
  for (const c of ['0,0', '-2,-9', '500,500', 'balmora, council club', 'anything at all']) assert.equal(m.regionOf(c), 'world');
});

test('every exterior and interior in a full cell list maps to exactly one region', () => {
  const m = new RegionMap(TWO, { 'balmora, council club': '3,3', 'caldera, guild': '-4,2' });
  const cells: string[] = [];
  for (let x = -40; x <= 40; x++) for (let y = -40; y <= 40; y++) cells.push(`${x},${y}`);
  cells.push('balmora, council club', 'caldera, guild', 'orphan interior with no known door');
  for (const c of cells) {
    const owners = m.ids.filter((id) => m.regionOf(c) === id);
    assert.equal(owners.length, 1, `${c} has ${owners.length} owners`);
  }
  assert.equal(m.regionOf('3,3'), 'east');
  assert.equal(m.regionOf('-1,3'), 'west');
  assert.equal(m.regionOf('balmora, council club'), 'east', 'interior follows its door');
  assert.equal(m.regionOf('caldera, guild'), 'west');
  assert.equal(m.regionOf('orphan interior with no known door'), 'west', 'unknown door: the default (first) region');
  assert.equal(m.regionOf('900,900'), 'west', 'outside every rectangle: the default region');
});

test('an interior learns its door once; the first door wins so ownership never flips under a holder', () => {
  const m = new RegionMap(TWO);
  assert.equal(m.learnDoor('shop', '5,5'), true);
  assert.equal(m.learnDoor('shop', '-5,5'), false);
  assert.equal(m.regionOf('shop'), 'east');
  assert.equal(m.learnDoor('0,0', '5,5'), false, 'an exterior is not an interior');
});

test('bad region definitions are refused at parse time', () => {
  assert.throws(() => new RegionMap([{ id: 'a b', rects: [] }]), /region id/);
  assert.throws(() => new RegionMap([{ id: 'a', rects: [] }, { id: 'a', rects: [] }]), /duplicate/);
  assert.throws(() => new RegionMap([{ id: 'a', rects: [{ x0: 5, y0: 0, x1: 1, y1: 0 }] }]), /bad rectangle/);
  assert.throws(() => parseRegionDefs([{ id: 'a', rects: [[1, 2, 3]] }]), /x0, y0, x1, y1/);
  assert.deepEqual(parseRegionDefs(undefined), []);
});

test('partition: each peer claims only its own cells; a border player anchors both sides', () => {
  const m = new RegionMap(TWO, { 'east shop': '5,0' });
  const held = ['-3,0', '-2,0', '-1,0', '0,0', '1,0', 'east shop'];
  const players = [
    { cellKey: '-3,0', x: -24000, y: 100, z: 0 },   // deep west: only west
    { cellKey: '-1,0', x: -100, y: 100, z: 0 },     // on the border: west AND east (ring reaches 0,y)
    { cellKey: '3,0', x: 25000, y: 0, z: 0 },       // deep east: only east
  ];
  const parts = partitionAnchors(m, players, held);
  assert.deepEqual(parts.get('west')!.claim, ['-1,0', '-2,0', '-3,0']);
  assert.deepEqual(parts.get('east')!.claim, ['0,0', '1,0', 'east shop']);
  assert.deepEqual(parts.get('east')!.interiors, ['east shop']);
  assert.deepEqual(parts.get('west')!.interiors, []);
  assert.equal(parts.get('west')!.anchors.length, 2, 'deep west + the border player');
  assert.equal(parts.get('east')!.anchors.length, 2, 'deep east + the border player');
  const claimed = [...parts.values()].flatMap((p) => p.claim);
  assert.equal(new Set(claimed).size, claimed.length, 'no cell is claimed by two peers');
  assert.equal(claimed.length, held.length, 'and none is dropped');
});

test('anchor sender: drift under the threshold is not sent; membership, big moves and the heartbeat are', () => {
  const s = new AnchorSender();
  const a = { anchors: [{ x: 0, y: 0, z: 0 }], interiors: ['shop'] };
  assert.equal(s.shouldSend(a, 1000), true, 'first send');
  assert.equal(s.shouldSend({ ...a, anchors: [{ x: 100, y: 0, z: 0 }] }, 3000), false, 'small drift');
  assert.equal(s.shouldSend({ ...a, anchors: [{ x: ANCHOR_DRIFT_UNITS + 50, y: 0, z: 0 }] }, 3500), true, 'past the drift limit');
  assert.equal(s.shouldSend({ anchors: [{ x: ANCHOR_DRIFT_UNITS + 50, y: 0, z: 0 }], interiors: [] }, 4000), true, 'interior left');
  assert.equal(s.shouldSend({ anchors: [], interiors: [] }, 4500), true, 'anchor left');
  assert.equal(s.shouldSend({ anchors: [], interiors: [] }, 5000), false, 'unchanged');
  assert.equal(s.shouldSend({ anchors: [], interiors: [] }, 4500 + ANCHOR_HEARTBEAT_MS), true, 'heartbeat');
  assert.equal(s.shouldSend({ anchors: [], interiors: [] }, 4600 + ANCHOR_HEARTBEAT_MS, true), true, 'forced (dummy placement)');
  s.reset();
  assert.equal(s.shouldSend({ anchors: [], interiors: [] }, 4601 + ANCHOR_HEARTBEAT_MS), true, 'a new peer starts from nothing');
});

// ---- supervisor: warm spare ----------------------------------------------------------------
function fakeChild(): ChildProcess {
  const c = new EventEmitter() as unknown as ChildProcess & { killed?: boolean };
  (c as unknown as { pid: number }).pid = 4242;
  (c as unknown as { stdout: null }).stdout = null;
  (c as unknown as { stderr: null }).stderr = null;
  (c as unknown as { kill: () => boolean }).kill = () => true;
  return c;
}
const SETTINGS: SimPeerSettings = {
  enabled: true, binary: '/bin/true', configDir: '/tmp', userDataDir: '/tmp', startCell: '0,0',
  maxPeers: 0, idleReapMs: 60_000, startTimeoutMs: 120_000, restartBackoffMs: 1000,
};

test('warm spare: a hello\'d spare is re-keyed to the region in one call, with no new process', () => {
  let spawned = 0;
  const sup = new SimPeerSupervisor({ settings: SETTINGS, wsUrl: () => 'ws://x', password: '',
    spawner: () => { spawned++; return fakeChild(); } });
  sup.ensure('spare');
  assert.equal(spawned, 1);
  assert.equal(sup.promote('spare', 'east'), false, 'not promoted before its hello (still loading)');
  sup.noteHello('spare');
  const t0 = performance.now();
  assert.equal(sup.promote('spare', 'east'), true);
  assert.ok(performance.now() - t0 < 2000, 'promotion is a re-key, well under 2 s');
  assert.equal(spawned, 1, 'no process was started for the region');
  assert.equal(sup.has('east'), true);
  assert.equal(sup.has('spare'), false);
  assert.equal(sup.keyOfAccount('simpeer-spare'), 'east', 'the connected spare now serves the region');
  sup.ensure('east');
  assert.equal(spawned, 1, 'ensure() sees the promoted peer and does not spawn another');
  sup.ensure('spare');
  assert.equal(spawned, 2, 'the spare is replaced');
  assert.equal(sup.promote('spare', 'east'), false, 'a taken region is never overwritten');
  sup.stopAll();
});

test('two regions run two peers: each region key has its own process', () => {
  const keys: string[] = [];
  const sup = new SimPeerSupervisor({ settings: SETTINGS, wsUrl: () => 'ws://x', password: '',
    spawner: (key) => { keys.push(key); return fakeChild(); } });
  sup.ensure('west');
  sup.noteHello('west'); // one cold start at a time: the next may begin once the first said hello
  sup.ensure('east');
  assert.deepEqual(keys, ['west', 'east']);
  assert.deepEqual(sup.keys().sort(), ['east', 'west']);
  sup.stopAll();
});

// ---- on the wire: two regions, one peer -------------------------------------------------------
test('on the wire: a peer serves its own region only; the other region is unsimulated and told so', async (t) => {
  const PASS = 'peer-secret-regions';
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PASS }, limits: { maxConnsPerIp: 16 },
      simPeer: { regions: TWO_CFG as never, warmSpare: false } } });
  t.after(() => server.close());
  server.config.simPeer.enabled = true;
  const peer = await TestClient.simPeer(server.port, PASS); // unmanaged: serves the default region (west)
  t.after(() => peer.close());
  const join = async (name: string, cell: string) => {
    const c = await TestClient.connect(server.port);
    t.after(() => c.close());
    await c.joinAsNew(name);
    await c.waitEvent('PlayerList');
    c.sendCellChange(cell, 1, 1, 0);
    return c;
  };
  const w = await join('Westerner', '-5,0');
  const e = await join('Easterner', '5,0');
  type A = { anchors: { x: number }[]; interiors: string[] };
  const ready = (c: TestClient) => c.inbox.events.filter((x) => x.name === 'SimReady').map((x) => (x.value as { ready: boolean }).ready);
  const first = (await peer.waitEvent('SimAnchors', (v) => (v as A).anchors.length >= 1, 12_000)).value as A;
  assert.equal(first.anchors.length, 1, 'the west peer is given the west player only: ' + JSON.stringify(first));
  assert.ok(first.anchors[0]!.x !== undefined);
  // SimReady is answered per region: a join in the east, which has no peer, is not ready.
  // The join-time answer is for the default region; entering the east (no peer) corrects it.
  const e2 = await join('Easterner2', '6,0');
  const eReady = (await e2.waitEvent('SimReady', (v) => (v as { ready: boolean }).ready === false, 6_000)
    .catch(() => assert.fail('a player in a region with no peer was never told it is unsimulated'))).value as { ready: boolean };
  assert.equal(eReady.ready, false);
  const w2 = await join('Westerner2', '-6,0');
  const wReady = (await w2.waitEvent('SimReady')).value as { ready: boolean };
  assert.equal(wReady.ready, true, 'west is served: ready, and never told otherwise');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!w2.inbox.events.some((x) => x.name === 'SimReady' && (x.value as { ready: boolean }).ready === false));
  // OT3-205: the west peer dies. West players are told the world is unsimulated; the east
  // player, whose region it never served, hears nothing new.
  const eastBefore = e2.inbox.events.filter((x) => x.name === 'SimReady').length;
  peer.close();
  await w2.waitEvent('SimReady', (v) => (v as { ready: boolean }).ready === false, 8_000)
    .catch(() => assert.fail('the west player was never told its peer is gone'));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(e2.inbox.events.filter((x) => x.name === 'SimReady').length, eastBefore, 'the east region was not announced to');
  void w; void e;
});
