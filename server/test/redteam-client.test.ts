// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// MODIFIED-CLIENT RED TEAM (MP-BACKLOG 358-370): each block is one row, asserting the refusal
// AND that the honest shape of the same message still lands. Server-side rules only; the peer
// half (global.lua stacking, #359) is covered by the Lua runner's source checks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type RunningServer } from '../src/server';
import { TestClient, tmpDataDir, readPlayerDoc } from './helpers';

const PEER_PASS = 'peer-secret-1';
const NPC_REF = { __refnum: { index: 300, contentFile: 0 } };
const NPC2_REF = { __refnum: { index: 301, contentFile: 0 } };

async function boot(t: { after(fn: () => unknown): void }, extra: Record<string, unknown> = {}, override: Record<string, unknown> = {}) {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: { limits: { maxConnsPerIp: 16 }, server: { password: PEER_PASS }, ...override }, ...extra });
  t.after(() => server.close());
  return { server, dataDir };
}

async function join(t: { after(fn: () => unknown): void }, server: RunningServer, name: string, cell = '0,0', x = 0, y = 0, z = 0) {
  const c = await TestClient.connect(server.port);
  t.after(() => c.close());
  const { welcome, playerId } = await c.joinAsNew(name);
  c.playerId = playerId;
  await c.waitEvent('PlayerList');
  c.sendCellChange(cell, x, y, z);
  await c.waitEvent('PlayerCellChange', (v) => (v as { id?: number }).id === playerId);
  return { c, charId: String(welcome['characterId']) };
}

// A chat line rides the same per-connection FIFO: once the watcher sees it, anything sent
// before it has been handled.
async function fence(from: TestClient, watcher: TestClient) {
  const text = `fence-${Math.random().toString(36).slice(2)}`;
  from.sendEvent('ChatSend', { text: `!${text}` });
  await watcher.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === text);
}
const settle = () => new Promise((r) => setTimeout(r, 250));

test('#358 a gold delta past a merchant purse is refused; a real sale is not', async (t) => {
  const { server, dataDir } = await boot(t);
  const { c, charId } = await join(t, server, 'Croesus');
  c.sendEvent('PlayerInventory', { items: [{ id: 'gold_001', n: 400 }] });
  await settle();
  c.sendEvent('PlayerInventory', { items: [{ id: 'gold_001', n: 10400 }] }); // Mudcrab's whole purse
  await settle();
  const refused = c.waitEvent('StateRefused');
  c.sendEvent('PlayerInventory', { items: [{ id: 'gold_001', n: 100_000_000 }] });
  assert.equal(((await refused).value as { kind?: string }).kind, 'PlayerInventory');
  await server.flush();
  assert.deepEqual(readPlayerDoc(dataDir, charId)?.['inventory'], [{ id: 'gold_001', n: 10400 }], 'the hoard landed');
});

test('#359 an active effect needs a source the player has, and adds are budgeted by magnitude', async (t) => {
  const { server } = await boot(t);
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  peer.sendCellChange('0,0', 0, 0, 0);
  const { c } = await join(t, server, 'Mage');
  peer.inbox.events.length = 0;
  c.sendEvent('PlayerActiveSpells', { add: [{ key: '1', id: 'npc_only_spell', effects: [0] }], remove: [] });
  await fence(c, peer);
  assert.equal(peer.inbox.events.filter((e) => e.name === 'AvatarActiveSpells').length, 0, 'an unknown source reached the avatar');
  // A custom record minted by this account: its real magnitude prices the add.
  c.sendEvent('RecordCreate', { tempId: 1, kind: 'spell', data: { name: 'big fortify', cost: 500,
    effects: Array.from({ length: 8 }, () => ({ id: 'fortifyhealth', magnitudeMin: 100, magnitudeMax: 100, duration: 60 })) } });
  const rid = ((await c.waitEvent('RecordCreateAck')).value as { recordNetId: string }).recordNetId;
  c.sendEvent('PlayerSpellbook', { add: [rid], remove: [] });
  await settle();
  c.sendEvent('PlayerActiveSpells', { add: [{ key: '2', id: rid, effects: [0, 1, 2, 3, 4, 5, 6, 7] }], remove: [] });
  await peer.waitEvent('AvatarActiveSpells', (v) => (v as { id?: number }).id === c.playerId);
  peer.inbox.events.length = 0;
  c.sendEvent('PlayerActiveSpells', { add: [{ key: '3', id: rid, effects: [0, 1, 2, 3, 4, 5, 6, 7] }], remove: [] }); // 800 more in the window
  await fence(c, peer);
  assert.equal(peer.inbox.events.filter((e) => e.name === 'AvatarActiveSpells').length, 0, 'the magnitude budget did not hold');
});

test('#360 record caps: effects, magnitude, cost floor, armor, charge, speed, reach', async (t) => {
  const { server } = await boot(t);
  const { c } = await join(t, server, 'Smith');
  await c.waitEvent('RecordsSync');
  const fx = (n: number, mag = 50, dur = 10) => Array.from({ length: n }, () => ({ id: 'fortifyhealth', magnitudeMin: mag, magnitudeMax: mag, duration: dur }));
  const bad = [
    { tempId: 1, kind: 'spell', data: { name: 'nine', effects: fx(9) } },
    { tempId: 2, kind: 'spell', data: { name: 'mag', effects: fx(1, 101) } },
    { tempId: 3, kind: 'spell', data: { name: 'dur', effects: fx(1, 10, 1441) } },
    { tempId: 4, kind: 'spell', data: { name: 'free', cost: 1, effects: fx(1, 100, 1440) } },
    { tempId: 5, kind: 'armor', data: { name: 'wall', baseArmor: 201 } },
    { tempId: 6, kind: 'enchantment', data: { name: 'battery', charge: 401, effects: fx(1) } },
    { tempId: 7, kind: 'weapon', data: { name: 'fast', speed: 2.5 } },
    { tempId: 8, kind: 'weapon', data: { name: 'long', reach: 3 } },
  ];
  for (const r of bad) c.sendEvent('RecordCreate', r);
  const good = [
    { tempId: 11, kind: 'spell', data: { name: 'max', cost: 12000, effects: fx(8, 100, 1440) } }, // floor: 8 x 100 x 1440 / 100
    { tempId: 12, kind: 'spell', data: { name: 'auto', isAutocalc: true, cost: 0, effects: fx(1, 100, 1440) } },
    { tempId: 13, kind: 'armor', data: { name: 'plate', baseArmor: 200 } },
    { tempId: 14, kind: 'weapon', data: { name: 'blade', speed: 2, reach: 2, chopMaxDamage: 60 } },
  ];
  for (const r of good) c.sendEvent('RecordCreate', r);
  await fence(c, c);
  await settle();
  const acks = c.inbox.events.filter((e) => e.name === 'RecordCreateAck').map((e) => (e.value as { tempId: number }).tempId).sort((a, b) => a - b);
  assert.deepEqual(acks, [11, 12, 13, 14]);
});

test('#361 (past the join grace) the jump is refused unless a cast, door or conversation preceded it', async (t) => {
  const { server } = await boot(t);
  const { c: a } = await join(t, server, 'Jumper');
  const { c: b } = await join(t, server, 'Watcher');
  // The join grace is real time; the server reads player.joinedWorldAt. Rewind it through the
  // roster rather than sleeping 15 s.
  const me = server.roster.get(a.playerId)!;
  me.joinedWorldAt = Date.now() - 60_000;
  b.inbox.events.length = 0;
  a.sendCellChange('0,0', 3000, 0, 0); // through the walls
  await fence(a, b);
  assert.equal(b.inbox.events.filter((e) => e.name === 'PlayerCellChange' && (e.value as { id?: number }).id === a.playerId).length, 0,
    'a declared teleport with no cause was relayed');
  a.sendEvent('CombatCast', { spellId: 'recall', casterId: a.playerId, kind: 'spell' }); // Recall
  a.sendCellChange('0,0', 3000, 0, 0);
  await b.waitEvent('PlayerCellChange', (v) => (v as { id?: number; x?: number }).id === a.playerId && (v as { x?: number }).x === 3000);
  a.sendEvent('DoorState', { ref: NPC_REF, cellKey: '0,0', open: true }); // a door used
  a.sendCellChange('0,0', 0, 3000, 0);
  await b.waitEvent('PlayerCellChange', (v) => (v as { id?: number; y?: number }).id === a.playerId && (v as { y?: number }).y === 3000);
  a.sendEvent('DialogueLock', { ref: NPC2_REF, cellKey: '0,0', want: true }); // a guild guide
  await a.waitEvent('DialogueLockResult');
  a.sendCellChange('0,0', 0, 0, 3000);
  await b.waitEvent('PlayerCellChange', (v) => (v as { id?: number; z?: number }).id === a.playerId && (v as { z?: number }).z === 3000);
});

// #362 spellbook half: pins playerstate.ts handleSpellbook's byAccount check (commit 56e147e1) --
// a custom record minted by ANOTHER account is refused (StateRefused{PlayerSpellbook}, anomaly
// spellbook_foreign_record) and never lands in the doc; the minter's own add still does.
test('#362 a spellbook add of another account\'s custom record is refused; the minter\'s own lands', async (t) => {
  const { server, dataDir } = await boot(t);
  const { c: a, charId: aChar } = await join(t, server, 'Spellmaker');
  const { c: b, charId: bChar } = await join(t, server, 'Copycat');
  a.sendEvent('RecordCreate', { tempId: 1, kind: 'spell', data: { name: 'private bolt', cost: 10,
    effects: [{ id: 'firedamage', magnitudeMin: 5, magnitudeMax: 10, duration: 1 }] } });
  const rid = ((await a.waitEvent('RecordCreateAck')).value as { recordNetId: string }).recordNetId;
  await b.waitEvent('RecordsSync', (v) => ((v as { records?: { recordNetId?: string }[] }).records ?? []).some((r) => r.recordNetId === rid));

  const refused = b.waitEvent('StateRefused');
  b.sendEvent('PlayerSpellbook', { add: [rid], remove: [] });
  assert.equal(((await refused).value as { kind?: string }).kind, 'PlayerSpellbook');
  a.sendEvent('PlayerSpellbook', { add: [rid], remove: [] });
  await fence(a, a);
  await settle();
  await server.flush();
  assert.deepEqual(readPlayerDoc(dataDir, bChar)?.['spells'] ?? [], [], "the foreign record landed in the copycat's book");
  assert.deepEqual(readPlayerDoc(dataDir, aChar)?.['spells'], [rid], "the minter's own add was refused");
});

// #363 position half: pins worldstate.ts MAX_POSITION_CLAIMS_PER_MIN = 5 (commit 56e147e1) --
// a script's PositionCell fires once, a loop does not: the 6th claim in a minute is dropped
// (anomaly position_claim) while the first 5 reach the holder.
test('#363 a non-holder\'s position claims are bounded to 5 a minute', async (t) => {
  const { server } = await boot(t);
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  peer.sendCellChange('0,0', 0, 0, 0);
  await peer.waitEvent('ActorAuthorityGrant', (v) => (v as { cellKey: string }).cellKey === '0,0');
  const { c } = await join(t, server, 'Teleporter');
  peer.inbox.events.length = 0;
  for (let i = 1; i <= 6; i++) c.sendEvent('ActorAI', { cellKey: '0,0', epoch: 0, ref: NPC_REF, position: { x: i, y: 0, z: 0 } });
  await fence(c, peer);
  const got = peer.inbox.events.filter((e) => e.name === 'ActorAI').map((e) => (e.value as { position: { x: number } }).position.x);
  assert.deepEqual(got, [1, 2, 3, 4, 5], 'the first five relay, the sixth is dropped');
});

test('#364 a loose object must be within reach; a streamed actor is not an object', async (t) => {
  const { server } = await boot(t);
  // The peer anchors 5,5; the (still-in-chargen) human stands in the neighbour 5,6, which the
  // peer therefore does not hold -- so both the reach rule and the actor rule are exercised
  // against a cell the player can see but does not simulate.
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  peer.sendCellChange('5,5', 0, 0, 0);
  const epoch = ((await peer.waitEvent('ActorAuthorityGrant', (v) => (v as { cellKey: string }).cellKey === '5,5')).value as { epoch: number }).epoch;
  const { c } = await join(t, server, 'Reacher', '5,6');
  await c.waitEvent('WorldCellState', (v) => (v as { cellKey: string }).cellKey === '5,6');
  c.sendEvent('ObjectSpawnRequest', { tempId: 1, recordId: 'gold_001', cellKey: '5,6', x: 3000, y: 0, z: 0, rotZ: 0, count: 1 });
  const farId = ((await c.waitEvent('ObjectSpawnAck')).value as { netId: number }).netId;
  c.sendEvent('ObjectSpawnRequest', { tempId: 2, recordId: 'gold_001', cellKey: '5,6', x: 100, y: 0, z: 0, rotZ: 0, count: 1 });
  const nearId = ((await c.waitEvent('ObjectSpawnAck')).value as { netId: number }).netId;
  c.sendEvent('ObjectTakeRequest', { opId: 1, net: farId, cellKey: '5,6' });
  const far = (await c.waitEvent('ObjectTakeResult', (v) => (v as { opId: number }).opId === 1)).value as { ok: boolean; reason?: string };
  assert.equal(far.ok, false); assert.equal(far.reason, 'unreachable');
  c.sendEvent('ObjectMove', { net: nearId, cellKey: '5,6', x: 4000, y: 0, z: 0, rotZ: 0 }); // across the cell: refused
  c.sendEvent('ObjectTakeRequest', { opId: 2, net: nearId, cellKey: '5,6' });
  assert.equal(((await c.waitEvent('ObjectTakeResult', (v) => (v as { opId: number }).opId === 2)).value as { ok: boolean }).ok, true, 'a reachable object was refused (or the far move landed)');
  // An actor the holder streams: the first accepted batch of a cell records its refs.
  peer.sendActorMoveBatch(epoch, [{ ref: { index: 300, contentFile: 0 }, pose: { x: 10, y: 10, z: 0, yaw: 0, pitch: 128, flags: 0, animVel: 0, counter: 0 } }]);
  await settle();
  c.sendEvent('ObjectDelete', { ref: NPC_REF, cellKey: '5,5' });
  c.sendEvent('ObjectTakeRequest', { opId: 3, ref: NPC_REF, cellKey: '5,5' });
  const actor = (await c.waitEvent('ObjectTakeResult', (v) => (v as { opId: number }).opId === 3)).value as { ok: boolean; reason?: string };
  assert.equal(actor.ok, false, 'a streamed actor was taken as loot');
  c.sendEvent('ResyncRequest', { cellKey: '5,5' });
  const state = (await c.waitEvent('WorldCellState', (v) => (v as { cellKey: string }).cellKey === '5,5')).value as { deleted: string[] };
  assert.equal(state.deleted.length, 0, 'a streamed actor was tombstoned');
});

test('#365 a first-open stack past 100 of anything but gold is clamped, the container still canonical', async (t) => {
  const { server } = await boot(t);
  const { c } = await join(t, server, 'Opener');
  await c.waitEvent('WorldCellState');
  c.sendEvent('ContainerOpen', { ref: NPC_REF, cellKey: '0,0', contents: [{ id: 'daedric_helm', n: 101 }] });
  c.sendEvent('ContainerOpen', { ref: NPC2_REF, cellKey: '0,0', contents: [{ id: 'gold_001', n: 5000 }, { id: 'arrow', n: 100 }] });
  await fence(c, c);
  c.sendEvent('ResyncRequest', { cellKey: '0,0' });
  const state = (await c.waitEvent('WorldCellState', (v) => (v as { cellKey: string }).cellKey === '0,0')).value as { containers: Record<string, { items: { id: string; n: number }[] }> };
  // #344 keeps big containers canonical (a 65+-stack merchant is real); #365 only refuses to
  // trust the COUNT of one stack: 101 daedric helms become 100, the arrows stay 100.
  assert.deepEqual(Object.keys(state.containers).sort(), ['c:300:0', 'c:301:0'].sort(), 'both containers became canonical');
  const helms = state.containers['c:300:0']?.items.find((i) => i.id === 'daedric_helm');
  assert.equal(helms?.n, 100, 'the implausible stack was clamped, not trusted');
});

test('#366 a human lowers the party bounty only out of a conversation', async (t) => {
  const { server } = await boot(t, {}, { sharing: { crime: true } });
  const { c: a } = await join(t, server, 'Thief');
  const { c: b } = await join(t, server, 'Friend');
  a.sendEvent('CrimeUpdate', { bounty: 40 });
  await b.waitEvent('CrimeUpdate', (v) => (v as { bounty: number }).bounty === 40);
  b.inbox.events.length = 0;
  a.sendEvent('CrimeUpdate', { bounty: 0 }); // forgiveness by declaration
  // #386: the refusal echoes the party's record to the sender, so a script pardon's client
  // does not keep 0 while the peer keeps hunting.
  const echo = (await a.waitEvent('CrimeUpdate')).value as { bounty: number; shared: boolean };
  assert.deepEqual(echo, { bounty: 40, shared: true }, 'the refused drop was not corrected on the sender');
  await fence(a, b);
  assert.equal(b.inbox.events.filter((e) => e.name === 'CrimeUpdate').length, 0, "a bare drop cleared the party's record");
  a.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '0,0', want: true }); // the guard
  await a.waitEvent('DialogueLockResult');
  a.sendEvent('CrimeUpdate', { bounty: 0 }); // the fine is paid
  assert.equal(((await b.waitEvent('CrimeUpdate')).value as { bounty: number }).bounty, 0);
});

test('#367 a lock is granted only in view, one at a time', async (t) => {
  const { server } = await boot(t);
  const { c: a } = await join(t, server, 'Talker');
  const { c: b } = await join(t, server, 'Other');
  a.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '9,9', want: true }); // an NPC across the map
  assert.equal(((await a.waitEvent('DialogueLockResult')).value as { granted: boolean }).granted, false);
  a.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '0,0', want: true });
  assert.equal(((await a.waitEvent('DialogueLockResult')).value as { granted: boolean }).granted, true);
  a.sendEvent('DialogueLock', { ref: NPC2_REF, cellKey: '0,0', want: true }); // a second window: the first is over
  assert.equal(((await a.waitEvent('DialogueLockResult')).value as { granted: boolean }).granted, true);
  b.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '0,0', want: true });
  assert.equal(((await b.waitEvent('DialogueLockResult')).value as { granted: boolean }).granted, true, 'the first NPC was still locked');
});

test('#369 a stat rises by a level-up step per window, a level by one; reputation by ten', async (t) => {
  const { server, dataDir } = await boot(t);
  const { c, charId } = await join(t, server, 'Grinder');
  c.sendEvent('PlayerAttributes', { strength: 40, luck: 40 });
  c.sendEvent('PlayerSkills', { longblade: 30 });
  c.sendEvent('PlayerLevel', { level: 3, reputation: 5 });
  await settle();
  c.sendEvent('PlayerAttributes', { strength: 45, luck: 41 }); // a level-up
  c.sendEvent('PlayerSkills', { longblade: 31 });
  c.sendEvent('PlayerSkills', { longblade: 32 }); // two gains in one window: ordinary grinding
  await settle();
  let refused = c.waitEvent('StateRefused');
  c.sendEvent('PlayerAttributes', { strength: 51, luck: 41 }); // +6 more in the window
  assert.equal(((await refused).value as { kind: string }).kind, 'PlayerAttributes');
  refused = c.waitEvent('StateRefused');
  c.sendEvent('PlayerSkills', { longblade: 101 });
  assert.equal(((await refused).value as { kind: string }).kind, 'PlayerSkills');
  refused = c.waitEvent('StateRefused');
  c.sendEvent('PlayerLevel', { level: 5, reputation: 5 }); // +2
  assert.equal(((await refused).value as { kind: string }).kind, 'PlayerLevel');
  refused = c.waitEvent('StateRefused');
  c.sendEvent('PlayerLevel', { level: 3, reputation: 16 }); // +11
  assert.equal(((await refused).value as { kind: string }).kind, 'PlayerLevel');
  c.sendEvent('PlayerLevel', { level: 4, reputation: 15 });
  await settle();
  await server.flush();
  const doc = readPlayerDoc(dataDir, charId) as { stats?: { attributes?: Record<string, number>; skills?: Record<string, number>; level?: number; reputation?: number } };
  assert.deepEqual(doc.stats?.attributes, { strength: 45, luck: 41 });
  assert.deepEqual(doc.stats?.skills, { longblade: 32 });
  assert.equal(doc.stats?.level, 4);
  assert.equal(doc.stats?.reputation, 15);
});

test('#370 a resync reads only what the player can see', async (t) => {
  const { server } = await boot(t);
  const { c } = await join(t, server, 'Reader');
  await c.waitEvent('WorldCellState');
  c.inbox.events.length = 0;
  c.sendEvent('ResyncRequest', { cellKey: 'Vivec, Hlaalu Vault' });
  c.sendEvent('ResyncRequest', { cellKey: '0,1' });
  await c.waitEvent('WorldCellState', (v) => (v as { cellKey: string }).cellKey === '0,1');
  assert.equal(c.inbox.events.filter((e) => e.name === 'WorldCellState' && (e.value as { cellKey: string }).cellKey === 'Vivec, Hlaalu Vault').length, 0,
    'a far cell doc was read');
});
