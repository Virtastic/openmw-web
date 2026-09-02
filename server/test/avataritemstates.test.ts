// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 4D: inventory keeps the peer's avatar current in BOTH directions.
//   owner -> avatar: a PlayerInventory snapshot forwards a refreshed AvatarState to the peer,
//                    so a weapon picked up mid-session is in the avatar's hands for 4C.
//   avatar -> owner: the peer reports wear/charge/soul (AvatarItemStatesBatch); the server
//                    owns doc.itemStates while the player is driving and hands the owner
//                    MP_SelfItemStates. One-writer: the client's own itemStates are ignored
//                    while peer reports are fresh -- COUNTS still land.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const PEER_PASS = 'peer-secret-1';

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
  const welcome = await a.joinAsNew('Wielder');
  a.playerId = welcome['playerId'] as number;
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  return { server, peer, a };
}

function drive(t: { after(fn: () => unknown): void }, c: TestClient) {
  let seq = 0;
  c.sendInput({ move: 1 }, ++seq);
  const timer = setInterval(() => c.sendInput({ move: 1 }, ++seq), 100);
  t.after(() => clearInterval(timer));
}

test('a PlayerInventory snapshot forwards a refreshed AvatarState to the peer', async (t) => {
  const { peer, a } = await world(t);
  peer.inbox.events.length = 0;
  a.sendEvent('PlayerInventory', { items: [{ id: 'iron_longsword', n: 1 }, { id: 'gold_001', n: 12 }] });
  const st = await peer.waitEvent('AvatarState',
    (v) => (v as { id?: number })?.id === a.playerId);
  const body = st.value as { inventory?: { id: string; n: number }[] };
  assert.ok(body.inventory?.some((i) => i.id === 'iron_longsword'),
    'the avatar copy must carry the weapon the owner now holds');
});

test('the peer\'s item-state report lands in the doc and reaches the owner', async (t) => {
  const { peer, a } = await world(t);
  drive(t, a);
  a.sendEvent('PlayerInventory', { items: [{ id: 'iron_longsword', n: 1 }] });
  await new Promise((r) => setTimeout(r, 150));
  peer.sendEvent('AvatarItemStatesBatch', {
    entries: [{ id: a.playerId, itemStates: { iron_longsword: [{ condition: 37 }] } }],
  });
  const got = await a.waitEvent('MP_SelfItemStates',
    (v) => Boolean((v as { itemStates?: Record<string, { condition?: number }[]> })?.itemStates?.iron_longsword));
  const states = (got.value as { itemStates: Record<string, { condition?: number }[]> }).itemStates;
  assert.equal(states.iron_longsword?.[0]?.condition, 37, 'the worn condition must reach the owner');
});

test('while peer states are fresh the client\'s own itemStates are ignored -- counts still land', async (t) => {
  const { peer, a } = await world(t);
  drive(t, a);
  a.sendEvent('PlayerInventory', { items: [{ id: 'iron_longsword', n: 1 }] });
  await new Promise((r) => setTimeout(r, 150));
  const reporter = setInterval(() => peer.sendEvent('AvatarItemStatesBatch', {
    entries: [{ id: a.playerId, itemStates: { iron_longsword: [{ condition: 37 }] } }],
  }), 200);
  t.after(() => clearInterval(reporter));
  await a.waitEvent('MP_SelfItemStates');

  // The client claims a fully repaired sword AND a new stack of gold.
  peer.inbox.events.length = 0;
  a.sendEvent('PlayerInventory', {
    items: [{ id: 'iron_longsword', n: 1 }, { id: 'gold_001', n: 40 }],
    itemStates: { iron_longsword: [{ condition: 999 }] },
  });
  // The forward to the peer carries the doc as written: peer-owned state, client-owned count.
  const st = await peer.waitEvent('AvatarState',
    (v) => (v as { id?: number })?.id === a.playerId
      && Boolean((v as { inventory?: { id: string }[] }).inventory?.some((i) => i.id === 'gold_001')));
  const body = st.value as { itemStates?: Record<string, { condition?: number }[]> };
  assert.equal(body.itemStates?.iron_longsword?.[0]?.condition, 37,
    'the peer\'s reported wear must survive the client\'s repaired claim');
});

test('an idle (non-driving) player\'s states are not overwritten by the peer', async (t) => {
  const { peer, a } = await world(t);
  a.sendEvent('PlayerInventory', {
    items: [{ id: 'iron_longsword', n: 1 }],
    itemStates: { iron_longsword: [{ condition: 500 }] },
  });
  await new Promise((r) => setTimeout(r, 150));
  peer.sendEvent('AvatarItemStatesBatch', {
    entries: [{ id: a.playerId, itemStates: { iron_longsword: [{ condition: 1 }] } }],
  });
  const got = await Promise.race([
    a.waitEvent('MP_SelfItemStates').then(() => true),
    new Promise<false>((r) => setTimeout(() => r(false), 800)),
  ]);
  assert.equal(got, false, 'a player the input tier is not serving keeps their own states');
});

test('a CLIENT sending AvatarItemStatesBatch is ignored', async (t) => {
  const { server, a } = await world(t);
  drive(t, a);
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Forger');
  await b.waitEvent('PlayerList');
  b.sendEvent('AvatarItemStatesBatch', {
    entries: [{ id: a.playerId, itemStates: { iron_longsword: [{ condition: 0 }] } }],
  });
  const got = await Promise.race([
    a.waitEvent('MP_SelfItemStates').then(() => true),
    new Promise<false>((r) => setTimeout(() => r(false), 800)),
  ]);
  assert.equal(got, false, 'only the world peer may author avatar item states');
});
