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
