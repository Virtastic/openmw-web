// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-199: daily guild contracts, party-shared.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bountyBoard, contractFor, dayOf, GUILDS, inTown, POOLS } from '../src/plugins/builtin/bounty-board';
import type { PluginApi } from '../src/plugins/api';
import type { Config } from '../src/config';

function fakeApi(over: {
  enabled?: boolean;
  members?: Record<number, string[]>; // id -> guilds
  parties?: Record<number, number>; // id -> party id
  requireMembership?: boolean;
}) {
  const gives: { id: number; recordId: string; count: number }[] = [];
  const chats: { target: 'all' | number; text: string }[] = [];
  const claims = new Set<string>();
  const ids = Object.keys(over.members ?? {}).map(Number);
  const api = {
    config: { bounties: { enabled: over.enabled ?? true, requireMembership: over.requireMembership ?? true, goldPerContract: 100 } } as unknown as Config,
    log: () => {},
    players: () => ids.map((id) => ({ id, name: `P${id}`, rank: 0 })),
    chat: (target: 'all' | number, msg: { text: string }) => { chats.push({ target, text: msg.text }); },
    sendEvent: () => {},
    factionRankOf: (id: number, f: string) => (over.members?.[id] ?? []).includes(f) ? 0 : undefined,
    partyIdOf: (id: number) => over.parties?.[id],
    partyOnline: (id: number) => {
      const party = over.parties?.[id];
      return party === undefined ? [] : ids.filter((o) => o !== id && over.parties?.[o] === party);
    },
    give: (id: number, recordId: string, count: number) => { gives.push({ id, recordId, count }); },
    claimOnce: (id: number, key: string) => { const k = `${id}|${key}`; if (claims.has(k)) return false; claims.add(k); return true; },
  } as unknown as PluginApi;
  return { api, gives, chats };
}

const today = () => dayOf(Date.now());
const kill = (api: PluginApi, recordId: string, witnesses: number[]) =>
  bountyBoard.onActorKilled!(api, { recordId, cellKey: '0,0', witnesses });

test('each guild posts one contract a day, the same for everyone, and it rotates', () => {
  for (const g of GUILDS) {
    assert.deepEqual(contractFor(g, 100), contractFor(g, 100));
    const seen = new Set(Array.from({ length: POOLS[g].length }, (_, d) => JSON.stringify(contractFor(g, d))));
    assert.equal(seen.size, POOLS[g].length, `${g} cycles its whole pool`);
  }
});

test('a party completes a Fighters Guild contract together and every member is paid once', () => {
  const c = contractFor('fighters guild', today());
  assert.equal(c.kind, 'kill');
  const { api, gives } = fakeApi({ members: { 1: ['fighters guild'], 2: ['fighters guild'], 3: [] }, parties: { 1: 7, 2: 7, 3: 7 } });
  const target = c.kind === 'kill' ? c.targets[0]! : '';
  // Both members saw every kill: still one count per kill for the party.
  for (let i = 0; i < c.n - 1; i++) kill(api, target, [1, 2]);
  assert.equal(gives.length, 0, 'not done yet');
  kill(api, target, [2]);
  assert.deepEqual(gives.map((g) => g.id).sort(), [1, 2], 'the non-member in the party is not paid');
  assert.ok(gives.every((g) => g.recordId === 'gold_001' && g.count === 100));
  // More kills the same day pay nothing more.
  for (let i = 0; i < c.n; i++) kill(api, target, [1]);
  assert.equal(gives.length, 2);
});

test('a kill of something else, or with the board off, counts for nothing', () => {
  const c = contractFor('fighters guild', today());
  const target = c.kind === 'kill' ? c.targets[0]! : '';
  const off = fakeApi({ enabled: false, members: { 1: ['fighters guild'] } });
  for (let i = 0; i < 10; i++) kill(off.api, target, [1]);
  assert.equal(off.gives.length, 0);
  const on = fakeApi({ members: { 1: ['fighters guild'] } });
  for (let i = 0; i < 10; i++) kill(on.api, 'not_a_target_creature', [1]);
  assert.equal(on.gives.length, 0);
});

test('a non-member makes no progress unless membership is not required', () => {
  const c = contractFor('fighters guild', today());
  const target = c.kind === 'kill' ? c.targets[0]! : '';
  const a = fakeApi({ members: { 1: [] } });
  for (let i = 0; i < c.n; i++) kill(a.api, target, [1]);
  assert.equal(a.gives.length, 0);
  const b = fakeApi({ members: { 1: [] }, requireMembership: false });
  for (let i = 0; i < c.n; i++) kill(b.api, target, [1]);
  assert.equal(b.gives.length, 1);
});

test('a Thieves Guild job counts unlocks inside the day\'s town only', () => {
  const c = contractFor('thieves guild', today());
  assert.equal(c.kind, 'unlock');
  const town = c.kind === 'unlock' ? c.town : '';
  const { api, gives } = fakeApi({ members: { 1: ['thieves guild'] } });
  const p = { id: 1, name: 'P1', rank: 0 };
  for (let i = 0; i < c.n; i++) bountyBoard.onLockOpened!(api, p, 'somewhere else, cellar');
  assert.equal(gives.length, 0);
  for (let i = 0; i < c.n; i++) bountyBoard.onLockOpened!(api, p, `${town}, some house`);
  assert.equal(gives.length, 1);
  assert.ok(inTown("Ald'ruhn, Guild of Fighters", "ald'ruhn") && !inTown('Balmoral', 'balmora'));
});

test('arrival tells a member their guilds\' boards', () => {
  const { api, chats } = fakeApi({ members: { 1: ['morag tong'] } });
  bountyBoard.onPlayerJoinWorld!(api, { id: 1, name: 'P1', rank: 0 });
  assert.equal(chats.length, 1);
  assert.match(chats[0]!.text, /Morag Tong contract today/);
});

// THE WIRING: a peer-reported death reaches the plugin with the human as witness, and the
// payout lands on that human as AdminGive.
test('end to end: kills reported by the peer pay the witness through AdminGive', async (t) => {
  const { startServer } = await import('../src/server');
  const { TestClient, tmpDataDir } = await import('./helpers');
  const PEER_PASS = 'peer-secret-bounty';
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS }, bounties: { enabled: true, requireMembership: false, goldPerContract: 77 } },
  });
  t.after(() => server.close());
  const peer = await TestClient.simPeer(server.port, PEER_PASS, 'Peer');
  peer.sendCellChange('0,0', 0, 0, 0);
  const grant = await peer.waitEvent('ActorAuthorityGrant');
  const epoch = (grant.value as { epoch: number }).epoch;
  const b = await TestClient.connect(server.port);
  const { playerId: bId } = await b.joinAsNew('Hunter');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);
  await b.waitEvent('PlayerCellChange');
  const c = contractFor('fighters guild', today());
  const target = c.kind === 'kill' ? c.targets[0]! : '';
  for (let i = 1; i <= c.n; i++) {
    peer.sendEvent('ActorDeath', { cellKey: '0,0', epoch, ref: { __refnum: { index: 100 + i, contentFile: 0 } }, killerPlayerId: bId, deathNo: 1, killedRecordId: target });
  }
  const give = await b.waitEvent('AdminGive');
  assert.deepEqual({ ...(give.value as object), note: undefined }, { recordId: 'gold_001', count: 77, note: undefined });
  b.close(); peer.close();
  await b.closed; await peer.closed;
});
