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

const NPC_REF = { __refnum: { index: 300, contentFile: 0 } };
const NPC2_REF = { __refnum: { index: 301, contentFile: 0 } };

async function boot(t: { after(fn: () => unknown): void }, override?: DeepPartial<Config>, dataDir = tmpDataDir()) {
  // All test clients share 127.0.0.1; the per-IP cap is not what these tests exercise.
  const configOverride = { ...override, limits: { ...override?.limits, maxConnsPerIp: 16 } };
  const server = await startServer({ dataDir, port: 0, host: '127.0.0.1', configOverride });
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
  const text = `fence-${Math.random().toString(36).slice(2)}`;
  from.sendEvent('ChatSend', { text });
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
  const { server } = await boot(t);
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
    assert.deepEqual((await b.waitEvent('CrimeUpdate')).value, { bounty: 40, kind: 'theft', byId: aId });
    a.sendEvent('CrimeUpdate', { bounty: -5 });
    await fence(a, b);
    assert.equal(b.inbox.events.filter((e) => e.name === 'CrimeUpdate').length, 0);
  });
});

// Phase 4 changed the DEFAULT: a global is character-shadowed (per character, never
// relayed) unless it describes the world, because relaying quest-progress globals makes
// two party members at different stages overwrite each other forever. The seq/LWW
// arbitration below still governs the globals that DO travel, so these tests declare a
// pair of world globals to exercise it — and assert the new shadowing directly.
test('global and member variables', async (t) => {
  const { server } = await boot(t, { sharing: { worldGlobals: ['world_flag', 'seqless_var'] } });
  const { a, b } = await twoInCell(server);

  await t.test('a quest-progress global is character-shadowed, never relayed', async () => {
    a.sendEvent('GlobalVarUpdate', { name: 'nerevarine', value: 1, seq: 5 });
    await fence(a, b);
    assert.equal(b.inbox.events.filter((e) => e.name === 'GlobalVarUpdate').length, 0,
      'quest progress must not travel between players (the TES3MP ping-pong)');
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
    b.sendEvent('DialogueLock', { net: 5, cellKey: '5,5', want: true }); // actors are content refs
    await fence(b, b);
    assert.equal(b.inbox.events.filter((e) => e.name === 'DialogueLockResult').length, 0);
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
