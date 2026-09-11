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

// THE BOUNTY THE PEER HUNTS IS THE WORLD'S, NOT THE DOC'S. With shared crime the party has one
// record: every client sets it on its own player, so every avatar must carry it too -- and it
// must survive the next AvatarState refresh, which used to re-seed each avatar from its own doc
// (0 for everyone but the campaign it was persisted on).
test('a shared bounty reaches every avatar and survives an AvatarState refresh', async (t) => {
  const { server, a } = await bootWithCharacter(t);
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  const wb = await b.joinAsNew('Bystander');
  b.playerId = wb['playerId'] as number;
  await b.waitEvent('PlayerList');
  b.sendEvent('PlayerLevel', { level: 2 }); // a fresh player has no doc; give the bystander one
  await new Promise((r) => setTimeout(r, 300));
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  await peer.waitEvent('AvatarState', (v) => (v as { id?: number })?.id === b.playerId, 8000);

  peer.inbox.events.length = 0;
  a.sendEvent('CrimeUpdate', { bounty: 500, kind: 'murder' });
  const crime = await peer.waitEvent('CrimeUpdate');
  assert.equal((crime.value as { shared?: boolean }).shared, true, 'the peer is told the record is shared');

  // A refresh of the BYSTANDER's avatar (any inventory change) must carry the party's bounty.
  b.sendEvent('PlayerInventory', { items: [{ id: 'gold_001', n: 5 }] });
  const st = await peer.waitEvent('AvatarState',
    (v) => (v as { id?: number })?.id === b.playerId && (v as { inventory?: unknown[] }).inventory !== undefined);
  assert.equal((st.value as { bounty?: number }).bounty, 500,
    "the bystander's avatar was re-seeded from their own doc and stopped being wanted");
});

// ARREST. A guard that reaches a wanted avatar on the peer cannot open a dialogue there; the
// peer reports it and the OWNER's client opens the dialogue with its copy of the guard. Only
// the world peer may say so -- a client saying it would force a dialogue onto someone's screen.
test('a guard reaching an avatar on the peer reaches the owner as PlayerArrest; a client cannot forge it', async (t) => {
  const { server, a } = await bootWithCharacter(t);
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  await peer.waitEvent('AvatarState', (v) => (v as { id?: number })?.id === a.playerId, 8000);
  const GUARD = { __refnum: { index: 77, contentFile: 0 } };

  a.inbox.events.length = 0;
  peer.sendEvent('PlayerArrest', { id: a.playerId, guard: GUARD });
  const got = await a.waitEvent('PlayerArrest');
  assert.ok((got.value as { guard?: unknown }).guard !== undefined, 'the guard reaches the owner');

  // ...and a crime the avatar committed on the peer reaches the owner as an increment.
  peer.sendEvent('PlayerCrime', { id: a.playerId, bounty: 40, kind: 'assault' });
  const crime = await a.waitEvent('PlayerCrime');
  assert.deepEqual(crime.value, { bounty: 40, kind: 'assault' }, 'the increment and kind reach the owner');

  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Forger');
  await b.waitEvent('PlayerList');
  a.inbox.events.length = 0;
  b.sendEvent('PlayerArrest', { id: a.playerId, guard: GUARD });
  b.sendEvent('PlayerCrime', { id: a.playerId, bounty: 5000, kind: 'murder' });
  b.sendEvent('ChatSend', { text: 'arrestfence' });
  await a.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'arrestfence');
  assert.equal(a.inbox.events.filter((e) => e.name === 'PlayerArrest').length, 0,
    'a client forced an arrest dialogue onto another player');
  assert.equal(a.inbox.events.filter((e) => e.name === 'PlayerCrime').length, 0,
    'a client made another player wanted');
});

// NEVER BUILD A CORPSE. A character who died and closed the tab has hp 0 on record (death is
// a flush point). The avatar the peer builds for their rejoin must not be dead on arrival, or
// its first bar report kills the player who just came back.
test("a character who left dead is handed to the peer with a sliver of health, not a corpse", async (t) => {
  const { server, a } = await bootWithCharacter(t);
  a.sendEvent('PlayerStatsDynamic', { hp: { c: 0, b: 80 }, mp: { c: 10, b: 50 }, ft: { c: 5, b: 100 } });
  await new Promise((r) => setTimeout(r, 300));
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  const got = await peer.waitEvent('AvatarState', (v) => (v as { id?: number }).id === a.playerId, 8000);
  const hp = (got.value as { stats?: { dynamic?: { hp?: { c: number; b: number } } } }).stats?.dynamic?.hp;
  assert.ok(hp && hp.c > 0 && hp.c <= 8 && hp.b === 80, `avatar seeded with hp ${JSON.stringify(hp)}: a corpse, or a full heal`);
});
