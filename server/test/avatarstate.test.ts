// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 2b: THE PEER GETS THE WHOLE CHARACTER, not a cosmetic puppet's look. To simulate an
// avatar authoritatively it needs attributes, skills, level, spells, and the inventory WITH
// per-item state (condition/charge/soul) — the itemStates regression has bitten this
// codebase before, which is why the field exists at all. A client must never receive it:
// another player's full inventory is not the client's business.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const PEER_PASS = 'peer-secret-1';

async function bootWithCharacter(t: { after(fn: () => unknown): void }) {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS } },
  });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  const welcome = await a.joinAsNew('Hera');
  a.playerId = welcome['playerId'] as number;
  await a.waitEvent('PlayerList');
  // Give the character substance: stats, an inventory with item state. (Attribute/skill/
  // spell bodies ride their own wire shapes; level + inventory are enough to pin the doc
  // -> AvatarState flow, and itemStates is the field with the regression history.)
  a.sendEvent('PlayerLevel', { level: 7 });
  a.sendEvent('PlayerInventory', {
    items: [{ id: 'iron longsword', n: 1 }, { id: 'gold_001', n: 250 }],
    itemStates: { 'iron longsword': [{ condition: 123 }] },
  });
  await new Promise((r) => setTimeout(r, 300)); // let the state family land in the doc
  return { server, a };
}

test('a joining peer receives AvatarState for every player already here', async (t) => {
  const { server, a } = await bootWithCharacter(t);
  t.after(() => a.close());

  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  const got = await peer.waitEvent('AvatarState', (v) => (v as { id?: number }).id === a.playerId, 8000);
  const body = got.value as {
    id: number;
    stats?: { attributes?: Record<string, number>; skills?: Record<string, number>; level?: number };
    spells?: string[];
    inventory?: { id: string; n: number }[];
    itemStates?: Record<string, { condition?: number }[]>;
  };
  assert.equal(body.stats?.level, 7, 'a default-statted mannequin computes the wrong fight');
  assert.ok((body.inventory ?? []).some((i) => i.id === 'iron longsword'));
  // THE regression this shape exists to prevent: without per-item state every handover
  // hands back repaired gear, recharged enchantments and emptied soul gems.
  assert.equal(body.itemStates?.['iron longsword']?.[0]?.condition, 123,
    'item condition did not reach the peer — the avatar would spawn with repaired gear');
});

test('a player joining after the peer is announced to it; a CLIENT never sees AvatarState', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS } },
  });
  t.after(() => server.close());

  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());

  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  await a.joinAsNew('Iole');
  await a.waitEvent('PlayerList');
  a.sendEvent('PlayerLevel', { level: 4 });
  await new Promise((r) => setTimeout(r, 300));
  // A rejoin re-runs syncStateOnJoin with the doc now populated.
  a.close();
  await a.closed;
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinExisting('Iole');

  const got = await peer.waitEvent('AvatarState',
    (v) => ((v as { stats?: { level?: number } }).stats?.level === 4), 8000);
  assert.ok(got, 'the peer was never told about the joining character');

  // The client heard about appearance/equipment at most — never the full doc.
  const leaked = b.inbox.events.some((e) => e.name === 'AvatarState');
  assert.equal(leaked, false, "another player's full inventory reached a client");
});
