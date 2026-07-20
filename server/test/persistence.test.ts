// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M2: playerstore round-trip/atomicity, restore-on-login, appearance/equipment fan-out,
// late-joiner state sync, stats visible-only relay, death -> resurrect flow.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PlayerStore } from '../src/persist/playerstore';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const APPEARANCE = { race: 'dark elf', head: 'b_n_dark elf_m_head_01', hair: 'b_n_dark elf_m_hair_02', isMale: true, class: 'nightblade', name: 'Drelas' };
const EQUIP_SLOTS = new Map<number, string>([[0, 'iron_helmet'], [16, 'iron_longsword']]);

test('playerstore round-trip and atomicity', async () => {
  const dataDir = tmpDataDir();
  const store = new PlayerStore(dataDir);
  store.update('drelas', (doc) => {
    doc.appearance = { ...APPEARANCE };
    doc.equipment = { 0: 'iron_helmet', 16: 'iron_longsword' };
    doc.inventory = [{ id: 'gold_001', n: 250 }];
    doc.stats = { level: 7, attributes: { strength: 55 } };
    doc.spells = ['fire_bite'];
    doc.position = { cellKey: '3,-2', x: 1, y: 2, z: 3 };
  });
  await store.close();

  // A crashed writer leaves only tmp litter; the doc itself must stay intact.
  const playersDir = join(dataDir, 'players');
  writeFileSync(join(playersDir, 'drelas.json.tmp-999-1'), '{"corrupt": tru'); // simulated mid-flush kill
  const store2 = new PlayerStore(dataDir);
  const doc = await store2.get('drelas');
  assert.deepEqual(doc?.appearance, APPEARANCE);
  assert.deepEqual(doc?.equipment, { 0: 'iron_helmet', 16: 'iron_longsword' }); // numeric keys restored
  assert.deepEqual(doc?.inventory, [{ id: 'gold_001', n: 250 }]);
  assert.equal(doc?.stats?.level, 7);
  assert.deepEqual(doc?.spells, ['fire_bite']);
  assert.deepEqual(doc?.position, { cellKey: '3,-2', x: 1, y: 2, z: 3 });
  // Only tmp litter + the real doc exist; the doc parses (rename was atomic).
  assert.ok(readdirSync(playersDir).includes('drelas.json'));
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(playersDir, 'drelas.json'), 'utf8')));
  await store2.close();
});

test('m2 state sync end to end', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  let a = await TestClient.connect(server.port);
  const first = await a.joinAsNew('Alice');
  let aId = first.playerId;
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 10, 20, 30);
  await a.waitEvent('PlayerCellChange');

  await t.test('appearance/equipment relay to ALL with id (sender included)', async () => {
    a.sendEvent('PlayerAppearance', APPEARANCE);
    const seen = await a.waitEvent('PlayerAppearance');
    assert.deepEqual(seen.value, { id: aId, ...APPEARANCE });
    a.sendEvent('PlayerEquipment', { slots: EQUIP_SLOTS });
    const eq = await a.waitEvent('PlayerEquipment');
    // Slot keys ride as Lua NUMBER keys -> lToJs renders the mixed-key table as __kv.
    assert.deepEqual(eq.value, { id: aId, slots: { __kv: [[0, 'iron_helmet'], [16, 'iron_longsword']] } });
  });

  await t.test('stats relay is visible-only; appearance is not', async () => {
    const b = await TestClient.connect(server.port);
    const { playerId: bId } = await b.joinAsNew('Bob');
    await b.waitEvent('PlayerList');
    b.sendCellChange('50,50', 0, 0, 0); // far from Alice
    await b.waitEvent('PlayerCellChange');

    // Far apart: appearance still fans out to all...
    a.sendEvent('PlayerAppearance', APPEARANCE);
    assert.deepEqual((await b.waitEvent('PlayerAppearance', (v) => (v as { id: number }).id === aId)).value, { id: aId, ...APPEARANCE });
    // ...but dynamic stats do not reach a far cell.
    b.inbox.events.length = 0;
    const stats = { hp: { c: 12.5, b: 50 }, mp: { c: 0, b: 30 }, ft: { c: 99, b: 100 } };
    a.sendEvent('PlayerStatsDynamic', stats);
    await a.waitEvent('PlayerStatsDynamic'); // sender's own cell sees it (proves relay ran)
    // FIFO fence on b's socket: the chat broadcast is enqueued after any would-be stats
    // relay, so once b sees it, no stats frame can still be in flight.
    a.sendEvent('ChatSend', { text: 'stats-fence' });
    await b.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'stats-fence');
    assert.equal(b.inbox.events.filter((e) => e.name === 'PlayerStatsDynamic').length, 0);

    // Adjacent: stats arrive.
    b.sendCellChange('1,1', 0, 0, 0);
    await b.waitEvent('PlayerCellChange');
    a.sendEvent('PlayerStatsDynamic', stats);
    const got = await b.waitEvent('PlayerStatsDynamic');
    assert.deepEqual(got.value, { id: aId, ...stats });
    assert.ok(bId !== aId);
    b.close();
    await b.closed;
    await a.waitEvent('PlayerLeaveWorld');
  });

  await t.test('store-only messages persist and Welcome restores the doc', async () => {
    a.sendEvent('PlayerAttributes', { strength: 55, intelligence: 40 });
    a.sendEvent('PlayerSkills', { longblade: 35, destruction: 22 });
    a.sendEvent('PlayerLevel', { level: 7 });
    a.sendEvent('PlayerSpellbook', { add: ['fire_bite', 'heal_companion'], remove: [] });
    a.sendEvent('PlayerSpellbook', { add: [], remove: ['heal_companion'] });
    a.sendEvent('PlayerInventory', { items: [{ id: 'gold_001', n: 250 }, { id: 'p_restore_health_s', n: 3 }] });
    a.sendMove({ x: 111, y: 222, z: 333 }); // freshest pose -> position at flush time
    a.sendEvent('ChatSend', { text: 'sync' }); // fence: all prior frames processed
    await a.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'sync');

    a.close();
    await a.closed;

    // Reconnect: Welcome must carry the doc.
    a = await TestClient.connect(server.port);
    a.hello();
    await a.waitJson('SessionHelloOk');
    a.login('Alice', 'hunter22'); // joinAsNew's fixed password
    const w = await a.waitJson('SessionWelcome');
    const rec = w['playerRecord'] as {
      appearance: typeof APPEARANCE;
      equipment: Record<string, string>;
      inventory: { id: string; n: number }[];
      stats: { dynamic: unknown; attributes: Record<string, number>; skills: Record<string, number>; level: number };
      spells: string[];
      position: { cellKey: string; x: number; y: number; z: number };
    };
    assert.deepEqual(rec.appearance, APPEARANCE);
    assert.deepEqual(rec.equipment, { '0': 'iron_helmet', '16': 'iron_longsword' }); // JSON keys are strings
    assert.deepEqual(rec.inventory, [{ id: 'gold_001', n: 250 }, { id: 'p_restore_health_s', n: 3 }]);
    assert.deepEqual(rec.stats.attributes, { strength: 55, intelligence: 40 });
    assert.deepEqual(rec.stats.skills, { longblade: 35, destruction: 22 });
    assert.equal(rec.stats.level, 7);
    assert.deepEqual(rec.spells, ['fire_bite']);
    assert.deepEqual(rec.position, { cellKey: '0,0', x: 111, y: 222, z: 333 }); // logout captured the live pose
    aId = w['playerId'] as number;
    a.sendJson({ t: 'SessionReady' });
    await a.waitEvent('PlayerList');
    a.sendCellChange('0,0', 111, 222, 333);
    await a.waitEvent('PlayerCellChange');
  });

  await t.test('late joiner receives existing players state; joiner stored state broadcasts', async () => {
    const c = await TestClient.connect(server.port);
    const { playerId: cId } = await c.joinAsNew('Cara');
    // Joiner gets Alice's cached appearance + equipment without Alice resending.
    const app = await c.waitEvent('PlayerAppearance', (v) => (v as { id: number }).id === aId);
    assert.deepEqual(app.value, { id: aId, ...APPEARANCE });
    const eq = await c.waitEvent('PlayerEquipment', (v) => (v as { id: number }).id === aId);
    assert.deepEqual(eq.value, { id: aId, slots: { __kv: [[0, 'iron_helmet'], [16, 'iron_longsword']] } });
    // Cara is fresh (no doc): Alice must receive nothing about her at join time.
    assert.equal(a.inbox.events.filter((e) => e.name === 'PlayerAppearance' && (e.value as { id: number }).id === cId).length, 0);

    // Cara relogging after chargen DOES broadcast her stored state to Alice.
    c.sendEvent('PlayerAppearance', { ...APPEARANCE, name: 'Cara' });
    await a.waitEvent('PlayerAppearance', (v) => (v as { id: number }).id === cId);
    c.close();
    await c.closed;
    await a.waitEvent('PlayerLeaveWorld');
    const c2 = await TestClient.connect(server.port);
    c2.hello();
    await c2.waitJson('SessionHelloOk');
    c2.login('Cara', 'hunter22');
    const w2 = await c2.waitJson('SessionWelcome');
    const c2Id = w2['playerId'] as number;
    c2.sendJson({ t: 'SessionReady' });
    const rejoined = await a.waitEvent('PlayerAppearance', (v) => (v as { id: number }).id === c2Id);
    assert.equal((rejoined.value as { name: string }).name, 'Cara');
    c2.close();
    await c2.closed;
  });

  await t.test('death fires plugins: PlayerResurrect at the configured spot', async () => {
    a.sendEvent('PlayerDeath', {});
    const res = await a.waitEvent('PlayerResurrect');
    // Coords come from [rules] in config (client agent maintains the real Village spot).
    const r = server.config.rules;
    assert.deepEqual(res.value, { cellKey: r.respawnCellKey, x: r.respawnX, y: r.respawnY, z: r.respawnZ, restoreHp: true });
  });

  await t.test('/status includes level', async () => {
    const status = (await (await fetch(`http://127.0.0.1:${server.port}/status`)).json()) as {
      players: { id: number; level?: number }[];
    };
    assert.equal(status.players.find((p) => p.id === aId)?.level, 7);
  });

  await t.test('invalid state bodies are dropped, not relayed', async () => {
    a.inbox.events.length = 0;
    a.sendEvent('PlayerAppearance', { race: 'x'.repeat(65), head: 'h', hair: 'h', isMale: true, class: 'c', name: 'n' });
    a.sendEvent('PlayerEquipment', { slots: new Map<number, string>([[21, 'too_high']]) });
    a.sendEvent('PlayerInventory', { items: [{ id: 'gold_001', n: 10001 }] });
    a.sendEvent('ChatSend', { text: 'fence2' });
    await a.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'fence2');
    assert.equal(a.inbox.events.filter((e) => ['PlayerAppearance', 'PlayerEquipment'].includes(e.name)).length, 0);
  });
});
