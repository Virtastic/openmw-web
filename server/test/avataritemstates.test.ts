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
  const got = await a.waitEvent('SelfItemStates',
    (v) => Boolean((v as { itemStates?: Record<string, { condition?: number }[]> })?.itemStates?.iron_longsword));
  const states = (got.value as { itemStates: Record<string, { condition?: number }[]> }).itemStates;
  assert.equal(states.iron_longsword?.[0]?.condition, 37, 'the worn condition must reach the owner');
});

test("while peer states are fresh the client's states merge per field: repairs and spends land, wear stays the peer's", async (t) => {
  const { peer, a } = await world(t);
  drive(t, a);
  a.sendEvent('PlayerInventory', { items: [{ id: 'iron_longsword', n: 1 }] });
  await new Promise((r) => setTimeout(r, 150));
  const reporter = setInterval(() => peer.sendEvent('AvatarItemStatesBatch', {
    entries: [{ id: a.playerId, itemStates: { iron_longsword: [{ condition: 37 }] } }],
  }), 200);
  t.after(() => clearInterval(reporter));
  await a.waitEvent('SelfItemStates');

  // The client repairs the sword (condition UP: the client alone swings hammers), spends the
  // charge of a ring (charge DOWN: the client alone casts from items), claims a soul in the
  // gem it carries (the peer alone fills gems -- the kill resolves there), and a new stack of
  // gold. Repair and spend must land; the soul must not; the count is the client's as before.
  clearInterval(reporter);
  peer.sendEvent('AvatarItemStatesBatch', {
    entries: [{ id: a.playerId, itemStates: {
      iron_longsword: [{ condition: 37 }], ring_of_fire: [{ charge: 100 }], misc_soulgem_common: [{}],
    } }],
  });
  await a.waitEvent('SelfItemStates', (v) => Boolean((v as { itemStates?: Record<string, unknown> })?.itemStates?.ring_of_fire));
  peer.inbox.events.length = 0;
  a.sendEvent('PlayerInventory', {
    items: [{ id: 'iron_longsword', n: 1 }, { id: 'ring_of_fire', n: 1 }, { id: 'misc_soulgem_common', n: 1 }, { id: 'gold_001', n: 40 }],
    itemStates: {
      iron_longsword: [{ condition: 999 }], ring_of_fire: [{ charge: 10 }], misc_soulgem_common: [{ soul: 'golden_saint' }],
    },
  });
  const st = await peer.waitEvent('AvatarState',
    (v) => (v as { id?: number })?.id === a.playerId
      && Boolean((v as { inventory?: { id: string }[] }).inventory?.some((i) => i.id === 'gold_001')));
  const body = st.value as { itemStates?: Record<string, { condition?: number; charge?: number; soul?: string }[]> };
  assert.equal(body.itemStates?.iron_longsword?.[0]?.condition, 999,
    'a repair happens only on the client and must reach the avatar, or hammers do nothing');
  assert.equal(body.itemStates?.ring_of_fire?.[0]?.charge, 10,
    'a cast from an item spends charge only on the client and must reach the avatar, or it is free');
  assert.equal(body.itemStates?.misc_soulgem_common?.[0]?.soul, undefined,
    "the soul is the peer's: the trap resolves where the kill happens");

  // ...and wear reported by the peer afterwards still lowers it: the peer may hurt.
  peer.sendEvent('AvatarItemStatesBatch', {
    entries: [{ id: a.playerId, itemStates: { iron_longsword: [{ condition: 900 }] } }],
  });
  const worn = await a.waitEvent('SelfItemStates',
    (v) => (v as { itemStates?: Record<string, { condition?: number }[]> })?.itemStates?.iron_longsword?.[0]?.condition === 900);
  assert.ok(worn, "the peer's wear report must still land after a repair");
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
    a.waitEvent('SelfItemStates').then(() => true),
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
    a.waitEvent('SelfItemStates').then(() => true),
    new Promise<false>((r) => setTimeout(() => r(false), 800)),
  ]);
  assert.equal(got, false, 'only the world peer may author avatar item states');
});
