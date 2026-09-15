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
  from.sendEvent('ChatSend', { text: `!${text}` });
  for (const w of watchers) await w.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === text);
}

test('journal arbitration and sharing', async (t) => {
  const { server } = await boot(t, { sharing: { regressAllowlist: ['a1_1_findspymaster'] } });
  const { a, b } = await twoInCell(server);

  await t.test('advancing index relays to peers, not back to the sender', async () => {
    a.sendEvent('JournalEntry', { questId: 'a1_1_thelefthanded', index: 10, actorRefId: 'caius cosades' });
    const got = await b.waitEvent('JournalEntry');
    assert.deepEqual(got.value, { questId: 'a1_1_thelefthanded', index: 10, actorRefId: 'caius cosades' });
    await fence(a, a);
    assert.equal(a.inbox.events.filter((e) => e.name === 'JournalEntry').length, 0);
  });

  await t.test('regression is blocked (stored, not relayed); equal index is a no-op', async () => {
    b.sendEvent('JournalEntry', { questId: 'a1_1_thelefthanded', index: 5 }); // lagging client
    b.sendEvent('JournalEntry', { questId: 'a1_1_thelefthanded', index: 10 }); // identical
    await fence(b, a);
    assert.equal(a.inbox.events.filter((e) => e.name === 'JournalEntry').length, 0);
    // Advancing past the max still works afterwards.
    b.sendEvent('JournalEntry', { questId: 'a1_1_thelefthanded', index: 20 });
    assert.equal(((await a.waitEvent('JournalEntry')).value as { index: number }).index, 20);
  });

  await t.test('allowlisted questId may regress', async () => {
    a.sendEvent('JournalEntry', { questId: 'a1_1_findspymaster', index: 50 });
    assert.equal(((await b.waitEvent('JournalEntry')).value as { index: number }).index, 50);
    b.sendEvent('JournalEntry', { questId: 'a1_1_findspymaster', index: 30 }); // legit regress
    assert.equal(((await a.waitEvent('JournalEntry')).value as { index: number }).index, 30);
  });

  await t.test('late joiner receives the full shared journal', async () => {
    const c = await TestClient.connect(server.port);
    await c.joinAsNew('Cara');
    const sync = await c.waitEvent('JournalSync');
    assert.deepEqual((sync.value as { quests: Record<string, number> }).quests, {
      a1_1_thelefthanded: 20,
      a1_1_findspymaster: 30,
    });
    c.close();
    await c.closed;
  });

  await t.test('malformed entries are dropped', async () => {
    a.sendEvent('JournalEntry', { questId: 'q', index: -1 });
    a.sendEvent('JournalEntry', { questId: 'q', index: 1.5 });
    a.sendEvent('JournalEntry', { questId: 'x'.repeat(65), index: 1 });
    a.sendEvent('JournalEntry', { index: 1 });
    await fence(a, b);
    assert.equal(b.inbox.events.filter((e) => e.name === 'JournalEntry').length, 0);
  });
});

test('journal and factions in individual mode', async (t) => {
  const { server } = await boot(t, { sharing: { journal: false, factions: false } });
  const { a, b } = await twoInCell(server);

  await t.test('nothing is relayed, but state is stored per player', async () => {
    a.sendEvent('JournalEntry', { questId: 'a1_1_thelefthanded', index: 10 });
    a.sendEvent('FactionUpdate', { factionId: 'blades', rank: 2, reputation: 5 });
    await fence(a, b);
    assert.equal(b.inbox.events.filter((e) => e.name === 'JournalEntry' || e.name === 'FactionUpdate').length, 0);
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

test('shared factions and crime relay', async (t) => {
  // crime is PERSONAL by default since backlog 353; this test is about the shared relay.
  const { server } = await boot(t, { sharing: { crime: true } });
  const { a, b, aId } = await twoInCell(server);

  await t.test('faction update relays with full state', async () => {
    a.sendEvent('FactionUpdate', { factionId: 'blades', rank: 3, reputation: 12, expelled: false });
    assert.deepEqual((await b.waitEvent('FactionUpdate')).value, {
      factionId: 'blades', rank: 3, reputation: 12, expelled: false,
    });
    a.sendEvent('FactionUpdate', { factionId: 'blades', rank: 99 }); // out of range
    a.sendEvent('FactionUpdate', { factionId: 'blades', rank: 1, expelled: 'yes' }); // wrong type
    await fence(a, b);
    assert.equal(b.inbox.events.filter((e) => e.name === 'FactionUpdate').length, 0);
  });

  await t.test('crime update relays with the reporter id', async () => {
    a.sendEvent('CrimeUpdate', { bounty: 40, kind: 'theft' });
    assert.deepEqual((await b.waitEvent('CrimeUpdate')).value, { bounty: 40, kind: 'theft', byId: aId, shared: true });
    a.sendEvent('CrimeUpdate', { bounty: -5 });
    await fence(a, b);
    assert.equal(b.inbox.events.filter((e) => e.name === 'CrimeUpdate').length, 0);
  });
});

// Phase 4 changed the DEFAULT: a global is character-shadowed (persisted to the CAMPAIGN,
// not seq-arbitrated) unless it describes the world. It is still relayed live to every
// engine running that campaign (backlog 224: one campaign per instance, and the other
// human's journal had already advanced with it); the peer-owned window (questpeer.test.ts)
// is what stops the TES3MP ping-pong. The seq/LWW arbitration below governs the WORLD
// globals, so these tests declare a pair of them to exercise it.
test('global and member variables', async (t) => {
  const { server } = await boot(t, { sharing: { worldGlobals: ['world_flag', 'seqless_var'] } });
  const { a, b } = await twoInCell(server);

  await t.test('a quest-progress global is relayed plain (no seq): campaign state, not arbitrated', async () => {
    a.sendEvent('GlobalVarUpdate', { name: 'nerevarine', value: 1, seq: 5 });
    assert.deepEqual((await b.waitEvent('GlobalVarUpdate')).value, { name: 'nerevarine', value: 1 },
      'a dialogue result must reach the other human live');
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
    const far = await TestClient.connect(server.port);
    await far.joinAsNew('Far');
    await far.waitEvent('PlayerList');
    far.sendCellChange('40,40', 0, 0, 0);
    await far.waitEvent('PlayerCellChange');

    a.sendEvent('MemberVarUpdate', { ref: NPC_REF, name: 'state', value: 3 });
    const got = await b.waitEvent('MemberVarUpdate');
    assert.deepEqual(got.value, { ref: NPC_REF, name: 'state', value: 3 });
    await fence(a, far);
    assert.equal(far.inbox.events.filter((e) => e.name === 'MemberVarUpdate').length, 0);
    far.close();
    await far.closed;
  });

  await t.test('member vars reach a joiner in the cell state', async () => {
    const late = await TestClient.connect(server.port);
    await late.joinAsNew('Late');
    await late.waitEvent('PlayerList');
    late.sendCellChange('0,0', 0, 0, 0);
    const state = (await late.waitEvent('WorldCellState', (v) => (v as { cellKey: string }).cellKey === '0,0')).value as { memberVars: unknown };
    assert.deepEqual(state.memberVars, { 'c:300:0': { state: 3 } });
    late.close();
    await late.closed;
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
  bob.sendEvent('MemberVarUpdate', { ref: NPC_REF, name: 'talked', value: 1 });
  const heard = await peer.waitEvent('MemberVarUpdate', () => true, 3000);
  assert.deepEqual(heard.value, { ref: NPC_REF, name: 'talked', value: 1 }, 'the simulator of the NPC hears its locals change');
});

test('dialogue lock', async (t) => {
  const { server } = await boot(t);
  const { a, b, aId } = await twoInCell(server);

  await t.test('first requester is granted, second is denied with the holder id', async () => {
    a.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '0,0', want: true });
    assert.deepEqual((await a.waitEvent('DialogueLockResult')).value, { ref: NPC_REF, granted: true });
    b.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '0,0', want: true });
    assert.deepEqual((await b.waitEvent('DialogueLockResult')).value, { ref: NPC_REF, granted: false, holderId: aId });
    // A different NPC is independent.
    b.sendEvent('DialogueLock', { ref: NPC2_REF, cellKey: '0,0', want: true });
    assert.deepEqual((await b.waitEvent('DialogueLockResult')).value, { ref: NPC2_REF, granted: true });
  });

  // PERSUASION: the one talking may say how the NPC now feels; anyone else may not.
  await t.test('the lock holder may relay the disposition it changed; a bystander may not', async () => {
    b.inbox.events.length = 0;
    a.sendEvent('ActorDisposition', { ref: NPC_REF, cellKey: '0,0', epoch: 0, disposition: 75 });
    const got = await b.waitEvent('ActorDisposition');
    assert.equal((got.value as { disposition?: number }).disposition, 75, 'the bribe reaches the other screen');
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
    assert.equal(a.inbox.events.filter((e) => e.name === 'ActorAI').length, 0, 'a bystander sent an NPC walking');
    // Re-take the lock so the release subtest below still has something to release.
    a.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '0,0', want: true });
    await a.waitEvent('DialogueLockResult');
  });

  await t.test('explicit release frees the NPC', async () => {
    a.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '0,0', want: false });
    await a.waitEvent('DialogueLockResult');
    b.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '0,0', want: true });
    assert.deepEqual((await b.waitEvent('DialogueLockResult')).value, { ref: NPC_REF, granted: true });
  });

  await t.test('leaving the cell releases locks taken there', async () => {
    b.sendCellChange('5,5', 0, 0, 0); // Bob holds NPC_REF + NPC2_REF in 0,0
    await b.waitEvent('PlayerCellChange');
    a.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '0,0', want: true });
    assert.deepEqual((await a.waitEvent('DialogueLockResult')).value, { ref: NPC_REF, granted: true });
  });

  // Backlog 33: the holder died mid-conversation. Their client tears the window down, so
  // the NPC must not stay refused to everyone else until the corpse changes cell.
  await t.test('the holder dying releases the lock', async () => {
    b.sendCellChange('0,0', 0, 0, 0); // Alice holds NPC_REF in 0,0 from the subtest above
    await b.waitEvent('PlayerCellChange');
    b.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '0,0', want: true });
    assert.equal(((await b.waitEvent('DialogueLockResult')).value as { granted: boolean }).granted, false, 'precondition: Alice holds it');
    a.sendEvent('PlayerDeath', {});
    await a.waitEvent('PlayerResurrect');
    b.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '0,0', want: true });
    assert.deepEqual((await b.waitEvent('DialogueLockResult')).value, { ref: NPC_REF, granted: true }, 'a corpse kept the NPC');
    b.sendEvent('DialogueLock', { ref: NPC_REF, cellKey: '0,0', want: false });
    await b.waitEvent('DialogueLockResult');
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

test('shared quest state survives a restart', async (t) => {
  const dataDir = tmpDataDir();
  let { server } = await boot(t, undefined, dataDir);
  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Alice');
  await a.waitEvent('PlayerList');
  await a.waitEvent('JournalSync');
  a.sendEvent('JournalEntry', { questId: 'a1_1_thelefthanded', index: 40 });
  a.sendEvent('GlobalVarUpdate', { name: 'nerevarine', value: 1, seq: 3 });
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
  assert.deepEqual((sync.value as { quests: Record<string, number> }).quests, { a1_1_thelefthanded: 40 });
  // The restored global still arbitrates: a stale seq is refused after restart.
  b.sendCellChange('0,0', 0, 0, 0);
  await b.waitEvent('PlayerCellChange');
  b.sendEvent('JournalEntry', { questId: 'a1_1_thelefthanded', index: 39 }); // regress, blocked
  b.sendEvent('JournalEntry', { questId: 'a1_1_thelefthanded', index: 41 });
  const c = await TestClient.connect(server.port);
  await c.joinAsNew('Cara');
  const sync2 = await c.waitEvent('JournalSync');
  assert.deepEqual((sync2.value as { quests: Record<string, number> }).quests, { a1_1_thelefthanded: 41 });
  c.close();
  await c.closed;
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
  const { server } = await boot(t);
  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Alice');
  await a.waitEvent('PlayerList');
  await a.waitEvent('JournalSync');
  a.sendEvent('JournalEntry', { questId: 'a1_1_thelefthanded', index: 10 });
  a.sendEvent('JournalEntry', { questId: 'a1_2_antabolisinformant', index: 10 });
  // Two months on: past the vanilla epoch (dayspassed clamps to 1 before 16 Last Seed).
  const joinClock = (await a.waitEvent('WorldTime')).value as { month: number };
  a.sendEvent('WorldTimeRequest', { advanceHours: 30 * 24, reason: 'rest' });
  await a.waitEvent('WorldTime', (v) => (v as { month: number }).month !== joinClock.month);
  a.sendEvent('WorldTimeRequest', { advanceHours: 30 * 24, reason: 'rest' });
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

test('dialogue topics reach the other player, and never bounce back to the sender', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Teller');
  await a.waitEvent('PlayerList');
  const b = await TestClient.connect(server.port);
  await b.joinAsNew('Listener');
  await b.waitEvent('PlayerList');

  // A learns two topics in conversation. Sharing them is the same rule the JOURNAL follows:
  // a guest's quest state routes through the host's journal, so without this they can be
  // looking at a quest in their log with no way to ask anyone about it.
  a.sendEvent('TopicsLearned', { topics: ['nerevarine', 'sixth house'] });
  const got = await b.waitEvent('TopicsLearned');
  const body = got.value as { topics: string[]; byId: number };
  assert.deepEqual(body.topics, ['nerevarine', 'sixth house']);

  // THE ECHO GUARD, which is the whole reason this is safe to ship. TES3MP synced topics and
  // earned "infinite topic packet spam" for it, and the mechanism is a loop: B applies the
  // topic, B's own diff then sees a topic it did not have, and sends it back to A. `byId`
  // names the origin so a client can recognise its own, and the client records an applied
  // topic in its baseline BEFORE adding it so the diff never reports it at all.
  assert.equal(typeof body.byId, 'number', 'the relay must name who learned it');

  // Proved by ORDERING rather than by waiting out a timeout for a non-event: B now learns a
  // topic of their own, and the FIRST thing A ever receives must be that one. If A had been
  // echoed its own, A's first event would be 'nerevarine'. This also runs in milliseconds
  // instead of burning the full wait, and unlike a timeout it cannot pass by accident.
  b.sendEvent('TopicsLearned', { topics: ['sleepers'] });
  const first = await a.waitEvent('TopicsLearned');
  assert.deepEqual((first.value as { topics: string[] }).topics, ['sleepers'],
    "the first topics A hears about must be B's — anything else means A was echoed its own");

  a.close(); b.close();
});

// Backlog 320: flipping journal sharing off and on again. In individual mode the owner's
// advances went to the host's doc through journalTarget (a hybrid: own map, host's log), and
// on the flip back the shared map was only seeded when EMPTY -- so a stale shared map replayed
// over the stages earned in individual mode, every login. Seed = max(shared, own), always.
test('shared -> individual -> shared keeps the owner\'s highest stage', async (t) => {
  const dataDir = tmpDataDir();
  const owned = (journal: boolean) => startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: 'private', worldOwner: 'host',
    configOverride: { login: { allowHarnessAuth: true }, sharing: { journal } } as never,
  });
  const q = 'a1_1_thelefthanded';
  const sync = async (c: TestClient) =>
    ((await c.waitEvent('JournalSync')).value as { quests: Record<string, number>; borrowed: boolean; journalLog: { q: string; i: number }[] });

  const s1 = await owned(true);
  const a = await TestClient.connect(s1.port);
  await a.joinAsNew('Host', 'hunter22');
  await a.waitEvent('PlayerList');
  await sync(a);
  a.sendEvent('JournalEntry', { questId: q, index: 10 });
  await new Promise((r) => setTimeout(r, 100));
  await s1.flush(); a.close(); await a.closed; await s1.close();

  const s2 = await owned(false);
  const b = await TestClient.connect(s2.port);
  await b.joinExisting('Host', 'hunter22');
  const own = await sync(b);
  assert.equal(own.quests[q], 10);
  assert.equal(own.borrowed, false, 'nothing is borrowed in individual mode');
  assert.deepEqual(own.journalLog.map((e) => e.i), [10], "individual mode serves the player's own log");
  b.sendEvent('JournalEntry', { questId: q, index: 30 });
  await new Promise((r) => setTimeout(r, 100));
  await s2.flush(); b.close(); await b.closed; await s2.close();

  const s3 = await owned(true);
  t.after(() => s3.close());
  const c = await TestClient.connect(s3.port);
  t.after(() => c.close());
  await c.joinExisting('Host', 'hunter22');
  const back = await sync(c);
  assert.equal(back.quests[q], 30, 'the stale shared map regressed the stage earned in individual mode');
  assert.deepEqual(back.journalLog.map((e) => e.i), [10, 30], 'the dated log kept both entries');
});

// Backlog 321: the journalLog cap is bounded by the JournalSync frame, not by taste. A full
// log beside a large quest map must decode -- LSER refuses past 65,536 nodes.
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
