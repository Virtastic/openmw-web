// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M6 quest layer: journal monotonic-max arbitration (+ regress allowlist), shared vs
// individual mode for journal and factions, global-var seq ordering and time-global
// exclusion, member vars, crime, dialogue-lock contention and release paths, and
// join-time JournalSync completeness.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type RunningServer } from '../src/server';
import type { DeepPartial, Config } from '../src/config';
import { TestClient, tmpDataDir } from './helpers';
import { daysPassed } from '../src/core/worldtime';

const NPC_REF = { __refnum: { index: 300, contentFile: 0 } };
const NPC2_REF = { __refnum: { index: 301, contentFile: 0 } };

async function boot(t: { after(fn: () => unknown): void }, override?: DeepPartial<Config>, dataDir = tmpDataDir()) {
  // All test clients share 127.0.0.1; the per-IP cap is not what these tests exercise.
  const configOverride = { ...override, limits: { ...override?.limits, maxConnsPerIp: 16 } };
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1', configOverride });
  t.after(() => server.close());
  return { server, dataDir };
}

// Two in-world clients in the same cell.
async function twoInCell(server: RunningServer, cellKey = '0,0') {
  const a = await TestClient.connect(server.port);
  const { playerId: aId } = await a.joinAsNew('Alice');
  await a.waitEvent('PlayerList');
  await a.waitEvent('JournalSync');
  a.sendCellChange(cellKey, 0, 0, 0);
  await a.waitEvent('PlayerCellChange');

  const b = await TestClient.connect(server.port);
  const { playerId: bId } = await b.joinAsNew('Bob');
  await b.waitEvent('PlayerList');
  await b.waitEvent('JournalSync');
  b.sendCellChange(cellKey, 0, 0, 0);
  await b.waitEvent('PlayerCellChange');
  return { a, b, aId, bId };
}

async function fence(from: TestClient, ...watchers: TestClient[]) {
  // '!' = the GLOBAL tier. Plain say is proximity-scoped (Phase 2.5), and a fence whose
  // watchers stand in other cells must not depend on hearing a neighbour.
  const text = `fence-${Math.random().toString(36).slice(2)}`;
  from.sendEvent('ChatSend', { text, channel: 'global' });
  for (const w of watchers) await w.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === text);
}

// OT3-51: journal, factions, bounty and topics are the character's own. Nothing is shared.
test('journal, factions and crime are per character', async (t) => {
  const { server } = await boot(t);
  const { a, b } = await twoInCell(server);

  await t.test('nothing is relayed, but state is stored per player', async () => {
    a.sendEvent('JournalEntry', { questId: 'a1_1_thelefthanded', index: 10 });
    a.sendEvent('JournalEntry', { questId: 'a1_1_thelefthanded', index: 5 }); // lagging client: refused
    a.sendEvent('FactionUpdate', { factionId: 'blades', rank: 2, reputation: 5 });
    a.sendEvent('CrimeUpdate', { bounty: 40, kind: 'theft' });
    a.sendEvent('TopicsLearned', { topics: ['background'] });
    await fence(a, b);
    assert.equal(b.inbox.events.filter((e) => ['JournalEntry', 'FactionUpdate', 'CrimeUpdate', 'TopicsLearned'].includes(e.name)).length, 0);
  });

  await t.test('malformed entries are dropped', async () => {
    a.sendEvent('JournalEntry', { questId: 'q', index: -1 });
    a.sendEvent('JournalEntry', { questId: 'q', index: 1.5 });
    a.sendEvent('JournalEntry', { questId: 'x'.repeat(65), index: 1 });
    a.sendEvent('JournalEntry', { index: 1 });
    a.sendEvent('FactionUpdate', { factionId: 'blades', rank: 99 }); // out of range
    a.sendEvent('CrimeUpdate', { bounty: -5 });
    await fence(a, a);
  });

  await t.test('rejoin sync serves the player their OWN journal', async () => {
    a.close();
    await a.closed;
    const back = await TestClient.connect(server.port);
    back.hello();
    await back.waitJson('SessionHelloOk');
    back.login('Alice', 'hunter22');
    await back.waitJson('SessionWelcome');
    back.sendJson({ t: 'SessionReady' });
    const sync = await back.waitEvent('JournalSync');
    assert.deepEqual((sync.value as { quests: Record<string, number> }).quests, { a1_1_thelefthanded: 10 });
    // Bob, who reported nothing, gets an empty map (not Alice's).
    b.sendEvent('ResyncRequest', { cellKey: '0,0' }); // any round-trip to keep b alive
    back.close();
    await back.closed;
  });
});

// A global is the character's (OT3-51: its doc, the peer, nobody else) unless it describes the
// world. The seq/LWW arbitration below governs the WORLD globals, so these tests declare a
// pair of them to exercise it.
test('global and member variables', async (t) => {
  const { server } = await boot(t, { sharing: { worldGlobals: ['world_flag', 'seqless_var'] } });
  const { a, b } = await twoInCell(server);

  await t.test("a quest-progress global stays on the writer's character (OT3-51)", async () => {
    a.sendEvent('GlobalVarUpdate', { name: 'nerevarine', value: 1, seq: 5 });
    await fence(a, b);
    assert.equal(b.inbox.events.filter((e) => e.name === 'GlobalVarUpdate').length, 0);
  });

  await t.test('world global relays and echoes the accepted seq', async () => {
    a.sendEvent('GlobalVarUpdate', { name: 'world_flag', value: 1, seq: 5 });
    assert.deepEqual((await b.waitEvent('GlobalVarUpdate')).value, { name: 'world_flag', value: 1, seq: 5 });
  });

  await t.test('stale and equal seq are dropped; higher seq wins', async () => {
    a.sendEvent('GlobalVarUpdate', { name: 'world_flag', value: 99, seq: 4 }); // stale
    a.sendEvent('GlobalVarUpdate', { name: 'world_flag', value: 98, seq: 5 }); // equal
    await fence(a, b);
    assert.equal(b.inbox.events.filter((e) => e.name === 'GlobalVarUpdate').length, 0);
    a.sendEvent('GlobalVarUpdate', { name: 'world_flag', value: 2, seq: 6 });
    assert.equal(((await b.waitEvent('GlobalVarUpdate')).value as { value: number }).value, 2);
  });

  await t.test('seqless updates are last-write-wins with a server-assigned seq', async () => {
    a.sendEvent('GlobalVarUpdate', { name: 'seqless_var', value: 7 });
    const first = (await b.waitEvent('GlobalVarUpdate')).value as { seq: number; value: number };
    assert.equal(first.value, 7);
    a.sendEvent('GlobalVarUpdate', { name: 'seqless_var', value: 8 });
    const second = (await b.waitEvent('GlobalVarUpdate')).value as { seq: number; value: number };
    assert.equal(second.value, 8);
    assert.ok(second.seq > first.seq, 'server-assigned seq must climb');
  });

  await t.test('M7 time globals are excluded', async () => {
    for (const name of ['GameHour', 'Day', 'Month', 'Year', 'DaysPassed', 'gamehour']) {
      a.sendEvent('GlobalVarUpdate', { name, value: 12, seq: 100 });
    }
    await fence(a, b);
    assert.equal(b.inbox.events.filter((e) => e.name === 'GlobalVarUpdate').length, 0);
  });

  await t.test('member vars relay cell-scoped and persist in the cell doc', async () => {
    // OT3-113: a human's NPC local is the writer's own character data, not the cell's.
    a.sendEvent('MemberVarUpdate', { ref: NPC_REF, name: 'state', value: 3, cellKey: '0,0' });
    await fence(a, b);
    assert.equal(b.inbox.events.filter((e) => e.name === 'MemberVarUpdate').length, 0, "Alice's progress does not reach Bob");
  });

  await t.test('a joiner sees defaults; the writer gets their own value back in the cell state', async () => {
    const late = await TestClient.connect(server.port);
    await late.joinAsNew('Late');
    await late.waitEvent('PlayerList');
    late.sendCellChange('0,0', 0, 0, 0);
    const state = (await late.waitEvent('WorldCellState', (v) => (v as { cellKey: string }).cellKey === '0,0')).value as { memberVars: unknown };
    assert.equal(Object.keys(state.memberVars as object).length, 0, "Bob/Late's dialogue with the NPC is unaffected by Alice");
    late.close();
    await late.closed;
    a.sendCellChange('40,40', 0, 0, 0);
    a.inbox.events.length = 0;
    a.sendCellChange('0,0', 0, 0, 0);
    const own = (await a.waitEvent('WorldCellState', (v) => (v as { cellKey: string }).cellKey === '0,0')).value as { memberVars: unknown };
    assert.deepEqual(own.memberVars, { 'c:300:0': { state: 3 } });
  });
});

// THE HOLDER HEARS ITS CELLS (worldstate.ts hears(), now for quest relays too). The peer's
// avatar parks a cell away while it keeps simulating the NPC whose locals a dialogue result
// just wrote; relayed by the avatar's neighbourhood alone, the one engine running that
// NPC's script never heard the write (backlog 222).
test('a member var reaches the peer holding the cell while its avatar stands elsewhere', async (t) => {
  const PEER_PASS = 'peer-secret-1';
  const { server } = await boot(t, { server: { password: PEER_PASS } });
  const bob = await TestClient.connect(server.port);
  t.after(() => bob.close());
  await bob.joinAsNew('Bob');
  await bob.waitEvent('PlayerList');
  bob.sendCellChange('0,0', 0, 0, 0);
  await bob.waitEvent('PlayerCellChange');
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  peer.sendCellChange('0,0', 0, 0, 0);
  await peer.waitEvent('ActorAuthorityGrant', (v) => (v as { cellKey: string }).cellKey === '0,0');
  peer.sendCellChange('9,9', 0, 0, 0); // parked far away; Bob keeps 0,0 occupied and held
  await peer.waitEvent('ActorAuthorityGrant', (v) => (v as { cellKey: string }).cellKey === '9,9');
  peer.inbox.events.length = 0;
  bob.sendEvent('MemberVarUpdate', { ref: NPC_REF, name: 'talked', value: 1, cellKey: '0,0' });
  const heard = await peer.waitEvent('MemberVarUpdate', () => true, 3000);
  assert.deepEqual(heard.value, { ref: NPC_REF, name: 'talked', value: 1, cellKey: '0,0' }, 'the simulator of the NPC hears its locals change');
});

// #77: in single player the world stops for a conversation. Here the holder keeps simulating,
// so the lock must tell it to park the NPC, and let it go on Goodbye or when the talker leaves.
test('a dialogue lock parks the NPC on the holder until it is released', async (t) => {
  const PEER_PASS = 'peer-secret-1';
  const { server } = await boot(t, { server: { password: PEER_PASS } });
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  peer.sendCellChange('0,0', 0, 0, 0);
  await peer.waitEvent('ActorAuthorityGrant', (v) => (v as { cellKey: string }).cellKey === '0,0');
  const bob = await TestClient.connect(server.port);
  t.after(() => bob.close());
  const bobId = (await bob.joinAsNew('Bob')).playerId;
  await bob.waitEvent('PlayerList');
  bob.sendCellChange('0,0', 0, 0, 0);
  await bob.waitEvent('PlayerCellChange');
  bob.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '0,0', want: true });
  await bob.waitEvent('DialogueLockResult');
  const parked = await peer.waitEvent('ActorAI', (v) => (v as { hold?: boolean }).hold === true, 3000);
  assert.deepEqual((parked.value as { ref?: unknown }).ref, NPC_REF, 'the holder is told which NPC to park');
  // ...and who is talking, so it turns to face them (the engine's greeting turn faces the
  // peer's dummy player, not the person speaking).
  assert.equal((parked.value as { by?: number }).by, bobId, 'the hold carries the talker');
  bob.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '0,0', want: false });
  await peer.waitEvent('ActorAI', (v) => (v as { hold?: boolean }).hold === false, 3000);
  // Walking off mid-conversation lets it go too (releaseDialogueLocks on a cell change).
  bob.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '0,0', want: true });
  await peer.waitEvent('ActorAI', (v) => (v as { hold?: boolean }).hold === true, 3000);
  bob.sendCellChange('5,5', 0, 0, 0);
  await peer.waitEvent('ActorAI', (v) => (v as { hold?: boolean }).hold === false, 3000);
});

test('dialogue lock', async (t) => {
  const { server } = await boot(t);
  const { a, b, aId } = await twoInCell(server);

  // OT3-155: a conversation is not a lock. Both talk to the same NPC at once.
  await t.test('two players talk to the same NPC at once', async () => {
    a.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '0,0', want: true });
    assert.deepEqual((await a.waitEvent('DialogueLockResult')).value, { ref: NPC_REF, granted: true });
    b.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '0,0', want: true });
    assert.deepEqual((await b.waitEvent('DialogueLockResult')).value, { ref: NPC_REF, granted: true });
    // Bob moves on to another NPC (one conversation each); Alice still holds hers.
    b.sendEvent('DialogueLock', { ref: NPC2_REF, cellKey: '0,0', want: true });
    assert.deepEqual((await b.waitEvent('DialogueLockResult')).value, { ref: NPC2_REF, granted: true });
  });

  // PERSUASION: the one talking may say how the NPC now feels -- about them; anyone else may not.
  await t.test("a talker's disposition is their own: kept, not relayed; a bystander's is dropped", async () => {
    b.inbox.events.length = 0;
    a.sendEvent('ActorDisposition', { ref: NPC_REF, cellKey: '0,0', epoch: 0, disposition: 75 });
    a.sendEvent('ChatSend', { text: 'bribefence' });
    await b.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'bribefence');
    assert.equal(b.inbox.events.filter((e) => e.name === 'ActorDisposition').length, 0, "alice's bribe is not bob's");
    // The Fight/Flee/Alarm a taunt wrote is shared: it relays, without the disposition.
    a.sendEvent('ActorDisposition', { ref: NPC_REF, cellKey: '0,0', epoch: 0, disposition: 10, ai: { fight: 90 } });
    const shared = (await b.waitEvent('ActorDisposition')).value as { disposition?: number; ai?: { fight?: number } };
    assert.equal(shared.ai?.fight, 90);
    assert.equal(shared.disposition, undefined);
    a.inbox.events.length = 0;
    b.sendEvent('ActorDisposition', { ref: NPC_REF, cellKey: '0,0', epoch: 0, disposition: 5 }); // not talking to them
    b.sendEvent('ChatSend', { text: 'dispfence' });
    await a.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'dispfence');
    assert.equal(a.inbox.events.filter((e) => e.name === 'ActorDisposition').length, 0,
      "a bystander changed an NPC's mind without talking to it");
  });

  // TAUNT / RESIST ARREST: the one who was talking may say the NPC now fights THEM, even a
  // moment after the window closed; never someone else, never about a third player.
  await t.test('the lock holder may say the NPC now fights them, for a few seconds after release', async () => {
    b.inbox.events.length = 0;
    a.sendEvent('ActorAI', { ref: NPC_REF, cellKey: '0,0', epoch: 0, combat: aId });
    const fight = await b.waitEvent('ActorAI');
    assert.equal((fight.value as { combat?: number }).combat, aId, 'the holder is told who the NPC fights');
    a.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '0,0', want: false });
    await a.waitEvent('DialogueLockResult');
    b.inbox.events.length = 0;
    a.sendEvent('ActorAI', { ref: NPC_REF, cellKey: '0,0', epoch: 0, combat: aId }); // just after Goodbye
    const late = await b.waitEvent('ActorAI');
    assert.equal((late.value as { combat?: number }).combat, aId, 'the consequence lands after the window closes');
    a.inbox.events.length = 0;
    b.sendEvent('ActorAI', { ref: NPC_REF, cellKey: '0,0', epoch: 0, combat: aId }); // Bob: not talking, not about himself
    b.sendEvent('ChatSend', { text: 'combatfence' });
    await a.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'combatfence');
    assert.equal(a.inbox.events.filter((e) => e.name === 'ActorAI').length, 0, 'a bystander set an NPC on someone');
    // ...and where a dialogue sent it (AITravel on Goodbye): same admission.
    b.inbox.events.length = 0;
    a.sendEvent('ActorAI', { ref: NPC_REF, cellKey: '0,0', epoch: 0, travel: { x: 10, y: 20, z: 30 } });
    const walk = await b.waitEvent('ActorAI');
    assert.deepEqual((walk.value as { travel?: unknown }).travel, { x: 10, y: 20, z: 30 }, 'the destination reaches the holder');
    a.inbox.events.length = 0;
    b.sendEvent('ActorAI', { ref: NPC_REF, cellKey: '0,0', epoch: 0, travel: { x: 1, y: 2, z: 3 } });
    b.sendEvent('ChatSend', { text: 'travelfence' });
    await a.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'travelfence');
    // Relaxed (backlog 363/79): a scripted walk from a nearby player inside reach is relayed, rate-bounded.
    assert.equal(a.inbox.events.filter((e) => e.name === 'ActorAI').length, 1, 'a scripted walk inside reach reaches the holder');
    // Re-take the lock so the release subtest below still has something to release.
    a.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '0,0', want: true });
    await a.waitEvent('DialogueLockResult');
  });

  await t.test('explicit release, then talking again', async () => {
    a.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '0,0', want: false });
    await a.waitEvent('DialogueLockResult');
    b.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '0,0', want: true });
    assert.deepEqual((await b.waitEvent('DialogueLockResult')).value, { ref: NPC_REF, granted: true });
  });

  await t.test('leaving the cell releases locks taken there', async () => {
    b.sendCellChange('5,5', 0, 0, 0);
    await b.waitEvent('PlayerCellChange');
    a.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '0,0', want: true });
    assert.deepEqual((await a.waitEvent('DialogueLockResult')).value, { ref: NPC_REF, granted: true });
  });

  // OT3-155: Alice's bribe of 75 above comes back to HER on entering the cell, and only her.
  await t.test('a personal disposition is replayed to its character on entering the cell', async () => {
    a.sendCellChange('5,5', 0, 0, 0);
    await a.waitEvent('PlayerCellChange');
    a.inbox.events.length = 0;
    a.sendCellChange('0,0', 0, 0, 0);
    const mine = await a.waitEvent('ActorDisposition', (v) => (v as { disposition?: number }).disposition === 10);
    assert.deepEqual((mine.value as { ref?: unknown }).ref, NPC_REF);
    b.inbox.events.length = 0;
    b.sendCellChange('0,0', 0, 0, 0);
    await b.waitEvent('PlayerCellChange');
    await fence(b, b);
    assert.equal(b.inbox.events.filter((e) => e.name === 'ActorDisposition').length, 0);
    b.sendCellChange('5,5', 0, 0, 0);
    await b.waitEvent('PlayerCellChange');
  });

  await t.test('disconnect releases every lock the player held', async () => {
    a.close();
    await a.closed;
    await b.waitEvent('PlayerLeaveWorld');
    b.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '5,5', want: true });
    assert.deepEqual((await b.waitEvent('DialogueLockResult')).value, { ref: NPC_REF, granted: true });
  });

  await t.test('malformed lock requests are dropped', async () => {
    b.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '5,5' }); // no want
    b.sendEvent('DialogueLock', { cellKey: '5,5', want: true }); // no ref
    b.sendEvent('DialogueLock', { net: 'x', cellKey: '5,5', want: true }); // net must be an id
    await fence(b, b);
    assert.equal(b.inbox.events.filter((e) => e.name === 'DialogueLockResult').length, 0);
    // A runtime actor the holder named (a script-placed quest NPC) is addressed by net id
    // and can be locked like any other.
    b.sendEvent('DialogueLock', { net: 5, cellKey: '5,5', want: true });
    assert.deepEqual((await b.waitEvent('DialogueLockResult')).value, { ref: 5, granted: true });
  });
});

test("a character's quest state survives a restart, and nobody else sees it", async (t) => {
  const dataDir = tmpDataDir();
  let { server } = await boot(t, undefined, dataDir);
  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Alice');
  await a.waitEvent('PlayerList');
  await a.waitEvent('JournalSync');
  a.sendEvent('JournalEntry', { questId: 'a1_1_thelefthanded', index: 40 });
  a.sendEvent('FactionUpdate', { factionId: 'blades', rank: 4 });
  await fence(a, a);
  await server.flush();
  a.close();
  await a.closed;
  await server.close();

  server = (await boot(t, undefined, dataDir)).server;
  const b = await TestClient.connect(server.port);
  await b.joinAsNew('Bob');
  await b.waitEvent('PlayerList');
  const sync = await b.waitEvent('JournalSync');
  assert.equal(Object.keys((sync.value as { quests: object }).quests).length, 0, "Bob is not shown Alice's log");
  const back = await TestClient.connect(server.port);
  back.hello();
  await back.waitJson('SessionHelloOk');
  back.login('Alice', 'hunter22');
  await back.waitJson('SessionWelcome');
  back.sendJson({ t: 'SessionReady' });
  const mine = await back.waitEvent('JournalSync');
  assert.deepEqual((mine.value as { quests: Record<string, number> }).quests, { a1_1_thelefthanded: 40 });
  back.close();
  await back.closed;
});

// Backlog 219: Sleepers / VampireCheck / MoveMehra are started once and expected to run for
// the rest of the game; the engine starts every session with none of them. The campaign doc
// keeps the union of started minus stopped, and hands it back at join.
test('running global scripts persist on the campaign doc and come back at join', async (t) => {
  const { server } = await boot(t);
  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Alice');
  await a.waitEvent('PlayerList');
  a.sendEvent('GlobalScriptsUpdate', { started: ['Sleepers', 'VampireCheck'] });
  a.sendEvent('GlobalScriptsUpdate', { started: ['MoveMehra'], stopped: ['vampirecheck'] });
  a.sendEvent('GlobalScriptsUpdate', { started: [] }); // nothing: dropped, not an error
  await fence(a, a);
  await server.flush();
  a.close();
  await a.closed;

  const again = await TestClient.connect(server.port);
  t.after(() => again.close());
  await again.joinExisting('Alice');
  const sync = (await again.waitEvent('GlobalScriptsSync')).value as { running: string[] };
  assert.deepEqual([...sync.running].sort(), ['movemehra', 'sleepers']);

  // Standalone: the sender's own doc. Another character has nothing running, so no sync at all.
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Bob');
  await b.waitEvent('PlayerList');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(b.inbox.events.filter((e) => e.name === 'GlobalScriptsSync').length, 0);
});

// Backlog 257: doc.journal is questId->index, so a relog rebuilt one entry per quest, in hash
// order, all dated today. The ordered, dated log rides JournalSync beside it.
test('the journal sync carries the entries in the order they were earned, with their days', async (t) => {
  const { server } = await boot(t, { rules: { timeSkip: 'anyone' } });
  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Alice');
  await a.waitEvent('PlayerList');
  await a.waitEvent('JournalSync');
  a.sendEvent('JournalEntry', { questId: 'a1_1_thelefthanded', index: 10 });
  a.sendEvent('JournalEntry', { questId: 'a1_2_antabolisinformant', index: 10 });
  // Two months on: past the vanilla epoch (dayspassed clamps to 1 before 16 Last Seed).
  const joinClock = (await a.waitEvent('WorldTime')).value as { month: number };
  a.sendEvent('WorldTimeRequest', { advanceHours: 30 * 24, reason: 'script' }); // OT3-108: a rest is personal
  await a.waitEvent('WorldTime', (v) => (v as { month: number }).month !== joinClock.month);
  a.sendEvent('WorldTimeRequest', { advanceHours: 30 * 24, reason: 'script' }); // OT3-108: a rest is personal
  const clock = (await a.waitEvent('WorldTime', (v) => (v as { month: number }).month === joinClock.month + 2)).value as { day: number; month: number; year: number };
  a.sendEvent('JournalEntry', { questId: 'a1_1_thelefthanded', index: 50 });
  a.sendEvent('JournalEntry', { questId: 'a1_1_thelefthanded', index: 50 }); // repeat: one line
  await fence(a, a);
  await server.flush();
  a.close();
  await a.closed;

  const again = await TestClient.connect(server.port);
  t.after(() => again.close());
  await again.joinExisting('Alice');
  const sync = (await again.waitEvent('JournalSync')).value as {
    quests: Record<string, number>;
    journalLog: { q: string; i: number; d: number; m: number; dm: number }[];
  };
  assert.deepEqual(sync.quests, { a1_1_thelefthanded: 50, a1_2_antabolisinformant: 10 });
  assert.deepEqual(sync.journalLog.map((e) => [e.q, e.i]),
    [['a1_1_thelefthanded', 10], ['a1_2_antabolisinformant', 10], ['a1_1_thelefthanded', 50]]);
  const [first, , third] = sync.journalLog as [typeof sync.journalLog[number], unknown, typeof sync.journalLog[number]];
  assert.ok(first.d >= 1 && first.m >= 1 && first.dm >= 1, 'stamped with the world clock');
  assert.ok(third.d > first.d, 'the later entry carries a later day');
  assert.deepEqual([third.d, third.m, third.dm], [daysPassed(clock), clock.month, clock.day], 'stamped with the clock as it stood');
});

test('a full journal log and a large quest map fit one JournalSync frame', async () => {
  const { lserNodeCount, LSER_MAX_NODES } = await import('../src/proto/lser');
  const journalLog = Array.from({ length: 5000 }, (_, i) => ({ q: `quest_${i % 700}`, i: (i % 20) * 10, d: i, m: 1 + (i % 12), dm: 1 + (i % 30) }));
  const quests: Record<string, number> = {};
  for (let i = 0; i < 700; i++) quests[`quest_${i}`] = 190;
  const nodes = lserNodeCount({ quests, borrowed: false, journalLog });
  assert.ok(nodes < LSER_MAX_NODES, `${nodes} nodes: a full JournalSync would not decode`);
});

// Backlog 321, the cap itself: the log keeps the NEWEST MAX_JOURNAL_LOG entries, so the first
// line of a campaign survives until the cap is actually crossed, and only then goes.
test('the journal log drops its oldest entry only past MAX_JOURNAL_LOG', async () => {
  const { Quests, MAX_JOURNAL_LOG } = await import('../src/core/quests');
  const time = { gameHour: 9, day: 16, month: 7, year: 427, timeScale: 30 };
  const q = new Quests({ cells: { worldM7: () => ({ time }) } } as unknown as ConstructorParameters<typeof Quests>[0]);
  const logEntry = (q as unknown as { logEntry(doc: { journalLog?: { q: string; i: number }[] }, q: string, i: number): void }).logEntry.bind(q);
  const doc: { journalLog?: { q: string; i: number }[] } = {};
  logEntry(doc, 'first', 1);
  for (let i = 1; i < MAX_JOURNAL_LOG; i++) logEntry(doc, `q${i}`, 1);
  assert.equal(doc.journalLog!.length, MAX_JOURNAL_LOG);
  assert.equal(doc.journalLog![0]!.q, 'first', `entry 1 survives ${MAX_JOURNAL_LOG - 1} later entries`);
  logEntry(doc, 'over', 1);
  assert.equal(doc.journalLog!.length, MAX_JOURNAL_LOG, 'the cap holds');
  assert.equal(doc.journalLog![0]!.q, 'q1', `entry 1 is gone at ${MAX_JOURNAL_LOG + 1}`);
  assert.equal(doc.journalLog![MAX_JOURNAL_LOG - 1]!.q, 'over', 'the newest entry is kept');
});

// OT3-168: a talker with no quest activity for DIALOGUE_IDLE_MS stops parking the NPC.
test('an idle dialogue lock is released; activity keeps it', async () => {
  const { Quests, DIALOGUE_IDLE_MS } = await import('../src/core/quests');
  const q = new Quests({ roster: { get: () => undefined } } as unknown as ConstructorParameters<typeof Quests>[0]);
  const locks = (q as unknown as { dialogueLocks: Map<string, Map<number, unknown>> }).dialogueLocks;
  const touch = (q as unknown as { touchDialogue(id: number, now: number): void }).touchDialogue.bind(q);
  const ref = { kind: 'ref', key: 'c:1:0' };
  locks.set('c:1:0', new Map([[1, { cellKey: '0,0', ref, at: 0 }], [2, { cellKey: '0,0', ref, at: 0 }]]));
  touch(2, DIALOGUE_IDLE_MS - 1);
  q.expireIdleDialogue(DIALOGUE_IDLE_MS);
  assert.equal(q.holdsDialogue(1), false, 'the stalled talker is released');
  assert.equal(q.holdsDialogue(2), true, 'the active talker keeps the conversation');
  q.expireIdleDialogue(2 * DIALOGUE_IDLE_MS);
  assert.equal(locks.size, 0, 'the NPC is let go with the last talker');
});
