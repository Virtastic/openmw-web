// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// 1.7.1 quest/journal/script fixes: guest triggers outside dialogue, restarts to logged
// stages, standalone peer persistence, refused global convergence, world-global seq at
// rejoin, member vars filed under the object's own cell.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir, readPlayerDoc } from './helpers';

const PEER_PASS = 'peer-secret-1';
type T = { after(fn: () => unknown): void };

const gv = (name: string) => (v: unknown) => (v as { name?: string })?.name === name;
const jq = (q: string) => (v: unknown) => (v as { questId?: string })?.questId === q;
const val = <K extends string>(e: { value: unknown }, k: K) => (e.value as Record<K, unknown>)[k];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function party(t: T, sharing?: Record<string, unknown>) {
  const { SocialStore } = await import('../src/core/socialstore');
  const dataDir = tmpDataDir();
  new SocialStore(dataDir).addFriend('host', 'guest', Date.now());
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    worldMode: 'party', worldOwner: 'host',
    configOverride: { server: { password: PEER_PASS }, login: { allowHarnessAuth: true }, ...(sharing ? { sharing } : {}) } as never,
  });
  t.after(() => server.close());
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  const host = await TestClient.connect(server.port);
  t.after(() => host.close());
  const hostChar = String((await host.joinAsNew('Host', 'hunter22')).welcome['characterId']);
  await host.waitEvent('PlayerList');
  host.sendCellChange('0,0', 0, 0, 0);
  const guest = await TestClient.connect(server.port);
  t.after(() => guest.close());
  await guest.joinAsNew('Guest', 'hunter22');
  await guest.waitEvent('PlayerList');
  guest.sendCellChange('0,0', 0, 0, 0);
  return { server, dataDir, peer, host, hostChar, guest };
}

// Item 1: an item's OnPCAdd, a lever's OnActivate or an area trigger advances a quest with no
// conversation open. The guest's write used to be relayed and never saved.
test("a guest's quest write right after their own scripted activation persists to the campaign", async (t) => {
  const { server, dataDir, host, hostChar, guest } = await party(t);
  guest.sendEvent('ObjectActivated', { net: 9, cellKey: '40,40' }); // from afar: not a trace
  guest.sendEvent('GlobalVarUpdate', { name: 'mp_far_gate', value: 3 });
  await host.waitEvent('GlobalVarUpdate', gv('mp_far_gate'), 3000);
  guest.sendEvent('ObjectActivated', { net: 9, cellKey: '0,0' });
  guest.sendEvent('JournalEntry', { questId: 'mq_lever', index: 10 });
  guest.sendEvent('GlobalVarUpdate', { name: 'mp_lever_gate', value: 1 });
  await host.waitEvent('GlobalVarUpdate', gv('mp_lever_gate'), 3000);
  await server.flush();
  const doc = readPlayerDoc(dataDir, hostChar) as { journal?: Record<string, number>; globals?: Record<string, number> };
  assert.equal(doc.journal?.['mq_lever'], 10, 'the activation-backed journal step was not saved');
  assert.equal(doc.globals?.['mp_lever_gate'], 1, 'the activation-backed global was not saved');
  assert.equal(doc.globals?.['mp_far_gate'], undefined, 'an activation from afar must not back a write');
});

// Item 4: the replay guard (backlog 335) holds only in the join-time window after JournalSync.
test('a regress to a logged stage is a replay just after JournalSync, and a restart after it', async (t) => {
  const { Quests } = await import('../src/core/quests');
  const { host, guest } = await party(t);
  const idx = (e: { value: unknown }) => val(e, 'index') as number;
  host.sendEvent('JournalEntry', { questId: 'mq_rep', index: 10 });
  assert.equal(idx(await guest.waitEvent('JournalEntry', jq('mq_rep'), 3000)), 10);
  host.sendEvent('JournalEntry', { questId: 'mq_rep', index: 50 });
  assert.equal(idx(await guest.waitEvent('JournalEntry', jq('mq_rep'), 3000)), 50);
  guest.inbox.events.length = 0;
  host.sendEvent('JournalEntry', { questId: 'mq_rep', index: 10 }); // inside the window: the replay's echo
  host.sendEvent('JournalEntry', { questId: 'mq_rep', index: 60 }); // fence
  assert.equal(idx(await guest.waitEvent('JournalEntry', jq('mq_rep'), 3000)), 60);
  assert.equal(guest.inbox.events.filter((e) => e.name === 'JournalEntry' && idx(e) === 10).length, 0, 'a replay echo was relayed');
  const windowMs = Quests.REPLAY_WINDOW_MS;
  Quests.REPLAY_WINDOW_MS = 0;
  t.after(() => { Quests.REPLAY_WINDOW_MS = windowMs; });
  host.sendEvent('JournalEntry', { questId: 'mq_rep', index: 10 });
  const e = await guest.waitEvent('JournalEntry', jq('mq_rep'), 3000);
  assert.equal(idx(e), 10, 'the restart is relayed');
  assert.equal(val(e, 'regress'), true);
});

// Item 5: on a standalone (owner-less) server the peer's advances reach the shared map that
// JournalSync sends after its log, and a joining peer is seeded from the shared campaign state.
test("standalone: the peer's journal advance lands in the shared map; a new peer is seeded with globals and scripts", async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS }, limits: { maxConnsPerIp: 16 } },
  });
  t.after(() => server.close());
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  await a.joinAsNew('Solo');
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  a.sendEvent('JournalEntry', { questId: 'mq_stand', index: 10 });
  await sleep(200);
  peer.sendEvent('JournalEntry', { questId: 'mq_stand', index: 40 });
  assert.equal(val(await a.waitEvent('JournalEntry', jq('mq_stand'), 3000), 'index'), 40);
  peer.sendEvent('GlobalVarUpdate', { name: 'mp_stand_peer', value: 5 });
  a.sendEvent('GlobalVarUpdate', { name: 'mp_stand_human', value: 2 });
  peer.sendEvent('GlobalScriptsUpdate', { started: ['Sleepers'] });
  await a.waitEvent('GlobalVarUpdate', gv('mp_stand_peer'), 3000);
  await sleep(300);

  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Second');
  const sync = await b.waitEvent('JournalSync', () => true, 3000);
  assert.equal((val(sync, 'quests') as Record<string, number>)['mq_stand'], 40, 'the stale shared map would lower the peer-advanced stage');

  peer.close();
  await sleep(500);
  const peer2 = await TestClient.simPeer(server.port, PEER_PASS, 'simpeer-two');
  t.after(() => peer2.close());
  const gs = await peer2.waitEvent('GlobalVarSync', () => true, 3000);
  const globals = val(gs, 'globals') as Record<string, number>;
  assert.equal(globals['mp_stand_peer'], 5, "the peer's own write seeds the next peer");
  assert.equal(globals['mp_stand_human'], 2, "a human's campaign global seeds the peer");
  const ss = await peer2.waitEvent('GlobalScriptsSync', () => true, 3000);
  assert.deepEqual(val(ss, 'running'), ['sleepers']);
});

// Item 6: a client write refused because the peer owns the name is answered with the winning
// value, so the refused engine converges instead of keeping its own until the next login.
test('a client write refused as peer-owned is answered with the peer value', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS }, limits: { maxConnsPerIp: 16 }, sharing: { questVars: true, worldGlobals: ['mp_world_gate'] } } as never,
  });
  t.after(() => server.close());
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  await a.joinAsNew('Refused');
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  peer.sendEvent('GlobalVarUpdate', { name: 'mp_char_gate', value: 7 });
  peer.sendEvent('GlobalVarUpdate', { name: 'mp_world_gate', value: 10, seq: 4 });
  await a.waitEvent('GlobalVarUpdate', gv('mp_world_gate'), 3000);
  a.inbox.events.length = 0;
  a.sendEvent('GlobalVarUpdate', { name: 'mp_char_gate', value: 3 });
  a.sendEvent('GlobalVarUpdate', { name: 'mp_world_gate', value: 99, seq: 5 });
  const back = await a.waitEvent('GlobalVarUpdate', gv('mp_char_gate'), 3000);
  assert.equal(val(back, 'value'), 7, 'the refused writer hears the winning campaign value');
  const w = await a.waitEvent('GlobalVarUpdate', gv('mp_world_gate'), 3000);
  assert.equal(val(w, 'value'), 10);
  assert.equal(val(w, 'seq'), 4, 'with the stored seq, so its next write is not stale');
});

// Item 7: a world-shared global's stored seq survives a relog while the client's restarts at
// 1. The join sync now carries the shared values with their seqs, and a stale write is answered.
test('a rejoiner is given world globals with their seqs, and a stale write is answered', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS }, limits: { maxConnsPerIp: 16 }, sharing: { questVars: true, worldGlobals: ['mp_world_seq'] } } as never,
  });
  t.after(() => server.close());
  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Seq');
  await a.waitEvent('PlayerList');
  for (let i = 1; i <= 3; i++) a.sendEvent('GlobalVarUpdate', { name: 'mp_world_seq', value: i, seq: i });
  await sleep(300);
  a.close();
  await sleep(300);
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinExisting('Seq');
  const gs = await b.waitEvent('GlobalVarSync', () => true, 3000);
  assert.equal((val(gs, 'globals') as Record<string, number>)['mp_world_seq'], 3, 'the world global is restored on join');
  assert.equal((val(gs, 'seqs') as Record<string, number>)['mp_world_seq'], 3, 'with its stored seq');
  b.sendEvent('GlobalVarUpdate', { name: 'mp_world_seq', value: 1, seq: 1 }); // a client that ignored the seed
  const back = await b.waitEvent('GlobalVarUpdate', gv('mp_world_seq'), 3000);
  assert.deepEqual([val(back, 'value'), val(back, 'seq')], [3, 3], 'the stale write is answered with the stored state');
});

// Item 8: an NPC's locals are filed under the NPC's own cell (the client names it, the server
// checks it is in reach), not under the cell the writing player stands in.
test("a member var is filed under the object's own cell, which must be in the writer's reach", async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS }, limits: { maxConnsPerIp: 16 } },
  });
  t.after(() => server.close());
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  await a.joinAsNew('Writer');
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  const c = await TestClient.connect(server.port);
  t.after(() => c.close());
  await c.joinAsNew('Neighbour');
  await c.waitEvent('PlayerList');
  c.sendCellChange('0,2', 0, 8192 * 2, 0);
  await sleep(200);
  const mv = (n: string) => (v: unknown) => (v as { name?: string })?.name === n;
  a.sendEvent('MemberVarUpdate', { net: 41, name: 'far_state', value: 2, cellKey: '0,2' }); // two cells off: out of reach, dropped
  a.sendEvent('MemberVarUpdate', { net: 41, name: 'npc_state', value: 3, cellKey: '0,1' });
  const got = await c.waitEvent('MemberVarUpdate', mv('npc_state'), 3000);
  assert.equal(val(got, 'value'), 3, "filed under 0,1, the write reaches a player who sees 0,1 but not the writer's 0,0");
  assert.equal(c.inbox.events.filter((e) => e.name === 'MemberVarUpdate' && mv('far_state')(e.value)).length, 0);
});
