// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-204: players and actors crossing a region border are handed from one region peer to the
// other -- exactly one author at a time, nothing lost on the way (the fight goes with the actor).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { RegionMap } from '../src/peers/regions';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const TWO_CFG = [
  { id: 'west', rects: [[-100, -100, -1, 100]] },
  { id: 'east', rects: [[0, -100, 100, 100]] },
];

function fakeChild(): ChildProcess {
  const c = new EventEmitter() as unknown as ChildProcess;
  Object.assign(c, { pid: 4243, stdout: null, stderr: null, kill: () => true });
  return c;
}

test('regionsNear: the owner first, then each other region of the 3x3, once; interiors and one region are just the owner', () => {
  const m = new RegionMap([
    { id: 'west', rects: [{ x0: -100, y0: -100, x1: -1, y1: 100 }] },
    { id: 'east', rects: [{ x0: 0, y0: -100, x1: 100, y1: 100 }] },
  ]);
  assert.deepEqual(m.regionsNear('-1,0'), ['west', 'east']);
  assert.deepEqual(m.regionsNear('0,0'), ['east', 'west']);
  assert.deepEqual(m.regionsNear('-5,0'), ['west']);
  assert.deepEqual(m.regionsNear('Balmora, Guild of Mages'), ['west']); // no door known: default
  assert.deepEqual(new RegionMap().regionsNear('-1,0'), ['world']);
});

test('on the wire: a player and a fighting creature cross the west/east border and back, one author at a time', async (t) => {
  const PASS = 'peer-secret-handoff';
  const spawned: string[] = [];
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PASS }, limits: { maxConnsPerIp: 16 },
      simPeer: { regions: TWO_CFG as never, warmSpare: false } },
    simPeerSpawner: (key) => { spawned.push(key); return fakeChild(); } });
  t.after(() => server.close());
  server.config.simPeer.enabled = true;
  server.config.simPeer.binary = '/bin/true';

  // The player stands on the west side of the border: west owns the cell, east owns the ring
  // cells across it, so BOTH region peers are needed.
  const p = await TestClient.connect(server.port);
  t.after(() => p.close());
  const welcome = await p.joinAsNew('Crosser');
  p.playerId = welcome['playerId'] as number;
  await p.waitEvent('PlayerList');
  p.sendCellChange('-1,0', -100, 10, 0);

  const until = async (what: string, ok: () => boolean, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) assert.fail(`timed out: ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  // The supervisor asks for the west peer first (one cold start at a time), then east.
  await until('west spawned', () => spawned.includes('west'));
  const west = await TestClient.simPeer(server.port, PASS, 'simpeer-west');
  t.after(() => west.close());
  await until('east spawned', () => spawned.includes('east'));
  const east = await TestClient.simPeer(server.port, PASS, 'simpeer-east');
  t.after(() => east.close());

  type Grant = { cellKey: string; epoch: number };
  const grantOf = async (peer: TestClient, cellKey: string) =>
    (await peer.waitEvent('ActorAuthorityGrant', (v) => (v as Grant).cellKey === cellKey, 15_000)).value as Grant;
  const westEpoch = (await grantOf(west, '-1,0')).epoch;
  const eastEpoch = (await grantOf(east, '0,0')).epoch;
  assert.ok(!west.inbox.events.some((e) => e.name === 'ActorAuthorityGrant' && (e.value as Grant).cellKey === '0,0'),
    'the cell across the border is claimed by its owner only');

  // ---- the player, west side: both peers get the input; only west's report counts --------
  let seq = 100;
  p.sendInput({ forward: 1 } as never, ++seq);
  await until('input reaches both peers', () =>
    west.inbox.inputForwards.some((f) => f.id === p.playerId) && east.inbox.inputForwards.some((f) => f.id === p.playerId));
  const skillUses = () => p.inbox.events.filter((e) => e.name === 'SelfSkillUse').length;
  east.sendEvent('AvatarSkillUse', { id: p.playerId, skill: 'block', useType: 0 });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(skillUses(), 0, 'the east peer does not author a west player\'s avatar');
  west.sendEvent('AvatarSkillUse', { id: p.playerId, skill: 'block', useType: 0 });
  await until('west report reaches the owner', () => skillUses() === 1);

  // ---- a creature in the west cell is fighting the player ------------------------------
  const ref = { __refnum: { index: 77, contentFile: 0 } };
  west.sendEvent('ActorAI', { cellKey: '-1,0', epoch: westEpoch, ref, combat: p.playerId });
  await new Promise((r) => setTimeout(r, 200));
  // It chases the player across the border into 0,0 (east).
  // waitEvent CONSUMES what it matched, so "exactly one" = the one taken + none left over.
  const left = (c: TestClient, name: string) => c.inbox.events.filter((e) => e.name === name).length;
  west.sendEvent('ActorCellChange', { cellKey: '-1,0', epoch: westEpoch, ref, toCellKey: '0,0', x: 10, y: 10, z: 0 });
  const handoff = (await west.waitEvent('ActorHandoff')).value as { cellKey: string; holderId: number };
  assert.equal(handoff.cellKey, '0,0');
  assert.equal(handoff.holderId, east.playerId, 'the old holder is told who simulates it now');
  await east.waitEvent('ActorCellChange', (v) => (v as { toCellKey: string }).toCellKey === '0,0');
  const fight = (await east.waitEvent('ActorAI', (v) => (v as { cellKey: string }).cellKey === '0,0')).value as
    { cellKey: string; combat: number; epoch: number };
  assert.equal(fight.combat, p.playerId, 'the fight goes with the creature: no loss');
  assert.equal(fight.cellKey, '0,0');
  assert.equal(fight.epoch, eastEpoch);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(left(west, 'ActorHandoff'), 0, 'one handoff, not two');
  assert.equal(left(east, 'ActorHandoff'), 0, 'the new holder is not told to give it up: no gap');

  // ---- the player crosses too: now east is the author, west is not ------------------------
  p.sendCellChange('0,0', 10, 10, 0);
  await new Promise((r) => setTimeout(r, 300));
  west.sendEvent('AvatarSkillUse', { id: p.playerId, skill: 'block', useType: 0 });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(skillUses(), 1, 'after the crossing the west peer no longer authors the avatar');
  east.sendEvent('AvatarSkillUse', { id: p.playerId, skill: 'block', useType: 0 });
  await until('east report reaches the owner', () => skillUses() === 2);
  const westIn = west.inbox.inputForwards.length, eastIn = east.inbox.inputForwards.length;
  p.sendInput({ forward: 1 } as never, ++seq);
  await until('input still reaches both while the player is at the border', () =>
    west.inbox.inputForwards.length > westIn && east.inbox.inputForwards.length > eastIn);

  // ---- and the creature chases them back west: handed back, fight intact -----------------
  east.sendEvent('ActorCellChange', { cellKey: '0,0', epoch: eastEpoch, ref, toCellKey: '-1,0', x: -10, y: 10, z: 0 });
  await east.waitEvent('ActorHandoff', (v) => (v as { cellKey: string }).cellKey === '-1,0');
  await west.waitEvent('ActorCellChange', (v) => (v as { toCellKey: string }).toCellKey === '-1,0');
  const back = (await west.waitEvent('ActorAI', (v) => (v as { cellKey: string; combat?: number }).cellKey === '-1,0'
    && (v as { combat?: number }).combat === p.playerId)).value as { epoch: number };
  assert.equal(back.epoch, westEpoch);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(left(east, 'ActorHandoff'), 0, 'handed back once');
  assert.equal(left(west, 'ActorHandoff'), 0, 'the holder it came back to keeps it');
});

test('one region: an actor changing cells under the same holder is no handoff', async (t) => {
  const PASS = 'peer-secret-onereg';
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PASS }, limits: { maxConnsPerIp: 16 } } });
  t.after(() => server.close());
  const peer = await TestClient.simPeer(server.port, PASS, 'Holder');
  t.after(() => peer.close());
  peer.sendCellChange('0,0', 0, 0, 0);
  const epoch = ((await peer.waitEvent('ActorAuthorityGrant')).value as { epoch: number }).epoch;
  const ref = { __refnum: { index: 5, contentFile: 0 } };
  peer.sendEvent('ActorCellChange', { cellKey: '0,0', epoch, ref, toCellKey: '1,0', x: 1, y: 1, z: 0 });
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!peer.inbox.events.some((e) => e.name === 'ActorHandoff'));
});
