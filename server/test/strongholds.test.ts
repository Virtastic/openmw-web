// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-198: a party member visiting the owner's stronghold sees the owner's copy and takes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostIn, strongholdAt } from '../src/plugins/builtin/strongholds';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';
import type { PluginApi } from '../src/plugins/api';
import type { Config } from '../src/config';

function fakeApi(journals: Record<number, Record<string, number>>, party: Record<number, number[]>, guestView = true) {
  return {
    config: { strongholds: { guestView } } as unknown as Config,
    journalOf: (id: number) => journals[id] ?? {},
    partyOnline: (id: number) => party[id] ?? [],
  } as unknown as PluginApi;
}

test('who is a guest: a party member without the quest, in the owner\'s stronghold only', () => {
  assert.equal(strongholdAt('Tel Uvirith, Seyda Neen')?.quest, 'ht_stronghold'); // prefix match
  assert.equal(strongholdAt('Balmora, Council Club'), undefined);
  const api = fakeApi({ 1: { HR_Stronghold: 20 }, 3: { hr_stronghold: 10 } }, { 2: [1, 3], 1: [2, 3], 3: [1, 2] });
  assert.equal(hostIn(api, 2, 'Indarys Manor'), 1, 'the guest is hosted by the owner');
  assert.equal(hostIn(api, 1, 'Indarys Manor'), undefined, 'the owner sees their own');
  assert.equal(hostIn(api, 3, 'Indarys Manor'), undefined, 'a co-builder sees their own');
  assert.equal(hostIn(api, 2, 'Rethan Manor'), undefined, 'nobody in the party built Rethan Manor');
  assert.equal(hostIn(api, 2, 'Balmora, Council Club'), undefined);
  assert.equal(hostIn(fakeApi({ 1: { hr_stronghold: 20 } }, {}), 2, 'Indarys Manor'), undefined, 'a stranger is no guest');
  assert.equal(hostIn(fakeApi({ 1: { hr_stronghold: 20 } }, { 2: [1] }, false), 2, 'Indarys Manor'), undefined, 'switched off');
});

const CELL = 'Indarys Manor';
const REF = { __refnum: { index: 4242, contentFile: 0 } };
type Items = { id: string; n: number }[];

test('end to end: the guest sees the owner\'s chest and can neither take nor put', async (t) => {
  const dataDir = tmpDataDir();
  // A personal-stash chest: the simplest container whose copies are per character.
  writeFileSync(join(dataDir, 'content-table.json'), JSON.stringify({ stashes: [`${CELL.toLowerCase()}|C:4242:0`] }));
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const a = await TestClient.connect(server.port);
  const { playerId: aId } = await a.joinAsNew('Owner');
  const b = await TestClient.connect(server.port);
  const { playerId: bId } = await b.joinAsNew('Guest');
  // The party and the owner's journal, as the plugin reads them (the same api object it holds).
  server.api.partyOnline = (id) => (id === aId ? [bId] : id === bId ? [aId] : []);
  server.api.journalOf = (id): Record<string, number> => (id === aId ? { hr_stronghold: 20 } : {});
  for (const c of [a, b]) {
    await c.waitEvent('PlayerList');
    c.sendCellChange(CELL, 0, 0, 0);
    await c.waitEvent('WorldCellState', (v) => (v as { cellKey: string }).cellKey === CELL);
  }
  await b.waitEvent('ChatMessage', (v) => /guest in Owner's Indarys Manor/.test((v as { text?: string }).text ?? ''));
  const open = async (c: TestClient): Promise<Items> => {
    c.inbox.events.length = 0;
    c.sendEvent('ContainerOpen', { ref: REF, cellKey: CELL, contents: [] });
    return ((await c.waitEvent('ContainerState')).value as { items: Items }).items;
  };
  const op = async (c: TestClient, opId: number, o: 'put' | 'take', itemId: string) => {
    c.inbox.events.length = 0;
    c.sendEvent('ContainerOpRequest', { ref: REF, cellKey: CELL, opId, op: o, itemId, n: 1 });
    return (await c.waitEvent('ContainerOpResult')).value as { ok: boolean; reason?: string };
  };
  await open(a);
  assert.equal((await op(a, 1, 'put', 'iron_dagger')).ok, true);
  assert.deepEqual(await open(b), [{ id: 'iron_dagger', n: 1 }], "the guest sees the owner's chest");
  const took = await op(b, 2, 'take', 'iron_dagger');
  assert.deepEqual([took.ok, took.reason], [false, 'guest']);
  assert.equal((await op(b, 3, 'put', 'ash_yam')).reason, 'guest');
  assert.deepEqual(await open(a), [{ id: 'iron_dagger', n: 1 }], 'the owner still has it');
  // NEGATIVE CONTROL: out of the party, the visitor is back on their own (empty) copy.
  server.api.partyOnline = () => [];
  assert.deepEqual(await open(b), []);
  assert.equal((await op(b, 4, 'put', 'ash_yam')).ok, true);
  a.close(); b.close();
  await a.closed; await b.closed;
});
