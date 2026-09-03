// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 4A: the peer reports each avatar's dynamic bars; the server owns the doc and hands
// the OWNER their own bars (MP_SelfStats). One writer: while peer reports are fresh, the
// client's own PlayerStatsDynamic assertion is ignored — and a player not driving the input
// tier keeps asserting their own (per-player degraded mode, same rule as avatar poses).

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const PEER_PASS = 'peer-secret-1';

const bars = (hp: number) => ({
  hp: { c: hp, b: 100 }, mp: { c: 50, b: 50 }, ft: { c: 80, b: 100 },
});

async function world(t: { after(fn: () => unknown): void }) {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS }, limits: { maxConnsPerIp: 16 } },
  });
  t.after(() => server.close());
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  const welcome = await a.joinAsNew('Runner');
  a.playerId = welcome['playerId'] as number;
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  return { server, peer, a };
}

test('a driving player gets MP_SelfStats from the peer report, and observers see the relay', async (t) => {
  const { server, peer, a } = await world(t);
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Watcher');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);

  // Arm the input tier: the peer's answers only rule a player who is driving.
  let seq = 0;
  a.sendInput({ move: 1 }, ++seq);
  const timer = setInterval(() => a.sendInput({ move: 1 }, ++seq), 100);
  t.after(() => clearInterval(timer));

  const reporter = setInterval(() => peer.sendEvent('AvatarStatsBatch', {
    entries: [{ id: a.playerId, ...bars(42) }],
  }), 100);
  t.after(() => clearInterval(reporter));

  const self = await a.waitEvent('SelfStats',
    (v) => (v as { hp?: { c?: number } })?.hp?.c === 42);
  assert.ok(self, 'the owner must receive their own bars');
  const seen = await b.waitEvent('PlayerStatsDynamic',
    (v) => (v as { id?: number; hp?: { c?: number } })?.id === a.playerId
      && (v as { hp?: { c?: number } }).hp?.c === 42);
  assert.ok(seen, 'observers render the peer-simulated bars');
});

test("while peer reports are fresh the client's own assertion is ignored", async (t) => {
  const { server, peer, a } = await world(t);
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Watcher2');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);

  let seq = 0;
  a.sendInput({ move: 1 }, ++seq);
  const timer = setInterval(() => a.sendInput({ move: 1 }, ++seq), 100);
  t.after(() => clearInterval(timer));
  const reporter = setInterval(() => peer.sendEvent('AvatarStatsBatch', {
    entries: [{ id: a.playerId, ...bars(42) }],
  }), 100);
  t.after(() => clearInterval(reporter));
  await a.waitEvent('SelfStats'); // the peer's stream is established

  // The forged full-health claim while the avatar says 42.
  a.sendEvent('PlayerStatsDynamic', bars(100));
  const relayed = await Promise.race([
    b.waitEvent('PlayerStatsDynamic',
      (v) => (v as { id?: number; hp?: { c?: number } })?.id === a.playerId
        && (v as { hp?: { c?: number } }).hp?.c === 100).then(() => true),
    new Promise<false>((r) => setTimeout(() => r(false), 800)),
  ]);
  assert.equal(relayed, false, 'the client claim must not interleave with the peer stream');
});

test('an input-less player keeps asserting their own bars (per-player degraded mode)', async (t) => {
  const { server, peer, a } = await world(t);
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Watcher3');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);

  // NO input from a. The peer's report for them must be ignored...
  peer.sendEvent('AvatarStatsBatch', { entries: [{ id: a.playerId, ...bars(1) }] });
  await new Promise((r) => setTimeout(r, 300));
  // ...and their own assertion still rules.
  a.sendEvent('PlayerStatsDynamic', bars(77));
  const seen = await b.waitEvent('PlayerStatsDynamic',
    (v) => (v as { id?: number; hp?: { c?: number } })?.id === a.playerId
      && (v as { hp?: { c?: number } }).hp?.c === 77);
  assert.ok(seen, 'client-authored bars stay live for a player the input tier is not serving');
});

test('a CLIENT sending AvatarStatsBatch is ignored', async (t) => {
  const { server, a } = await world(t);
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  const wb = await b.joinAsNew('Forger');
  b.playerId = wb['playerId'] as number;
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);

  let seq = 0;
  a.sendInput({ move: 1 }, ++seq);
  const timer = setInterval(() => a.sendInput({ move: 1 }, ++seq), 100);
  t.after(() => clearInterval(timer));

  b.sendEvent('AvatarStatsBatch', { entries: [{ id: a.playerId, ...bars(0) }] });
  const got = await Promise.race([
    a.waitEvent('SelfStats').then(() => true),
    new Promise<false>((r) => setTimeout(() => r(false), 800)),
  ]);
  assert.equal(got, false, 'only the world peer may author avatar bars');
});

// HEALING while the peer owns your bars. Potions, rest and self-cast healing all still happen
// on the CLIENT's engine (the avatar drinks nothing until the discrete-intent tier), so a
// client claim that RAISES a bar has to reach the avatar -- otherwise every potion did nothing,
// overwritten by the un-restored avatar a moment later. That opening is budgeted: "a raise is a
// restoration" is an immortality exploit without one.
test('a client heal reaches the peer, and sustained fake healing is refused', async (t) => {
  const { peer, a } = await world(t);
  let seq = 0;
  a.sendInput({ move: 1 }, ++seq);
  const timer = setInterval(() => a.sendInput({ move: 1 }, ++seq), 100);
  t.after(() => clearInterval(timer));
  // The peer owns the bars and has hurt this player.
  const reporter = setInterval(() => peer.sendEvent('AvatarStatsBatch', {
    entries: [{ id: a.playerId, ...bars(20) }],
  }), 150);
  t.after(() => clearInterval(reporter));
  await a.waitEvent('SelfStats', (v) => (v as { hp?: { c?: number } })?.hp?.c === 20);

  // A potion-sized restoration is accepted and forwarded to the avatar.
  peer.inbox.events.length = 0;
  a.sendEvent('PlayerStatsDynamic', bars(60));
  const restore = await peer.waitEvent('AvatarRestore',
    (v) => (v as { id?: number })?.id === a.playerId);
  assert.equal((restore.value as { hp?: { c?: number } }).hp?.c, 60,
    'a legitimate heal must reach the avatar, or potions do nothing');

  // Now the cheat: claim full health over and over. The budget (2x max health per 10s) runs
  // out and further claims are ignored -- the peer's bars stand.
  peer.inbox.events.length = 0;
  for (let i = 0; i < 40; i++) a.sendEvent('PlayerStatsDynamic', bars(100));
  await new Promise((r) => setTimeout(r, 600));
  const restores = peer.inbox.events.filter((e) => e.name === 'AvatarRestore').length;
  assert.ok(restores < 8,
    `sustained fake healing was accepted ${restores} times -- a modified client would be `
    + 'immortal while the peer owns its bars');
});
