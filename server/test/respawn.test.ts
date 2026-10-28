// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// WHERE YOU COME BACK, which is a gameplay decision rather than a technicality.
//
// It used to be an unconditional teleport to [rules] respawnCellKey, whose shipped default WAS
// the EXAMPLE SUITE demo's village — a coordinate from a different game world. The default is
// "" now (where you fell, backlog 355); the fixture keeps the village as an operator's choice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { respawn } from '../src/plugins/builtin/respawn';
import type { PluginApi, PluginPlayer } from '../src/plugins/api';
import type { Config } from '../src/config';

const DEAD: PluginPlayer = { id: 1, name: 'Faller', rank: 0 };

function fakeApi(over: {
  positions?: Record<number, { cellKey: string; x: number; y: number; z: number }>;
  respawnCellKey?: string;
  simPeer?: boolean;
  party?: number[];
}) {
  const events: { target: 'all' | number; name: string; body: unknown }[] = [];
  const chats: { target: 'all' | number; text: string }[] = [];
  const logs: { event: string; fields?: Record<string, unknown> }[] = [];
  const api = {
    config: {
      rules: {
        respawnCellKey: over.respawnCellKey ?? '26,25',
        respawnX: 216831, respawnY: 204909, respawnZ: 513,
      },
      simPeer: { enabled: over.simPeer ?? false },
    } as unknown as Config,
    log: (_l: string, event: string, fields?: Record<string, unknown>) => { logs.push({ event, fields }); },
    sendEvent: (target: 'all' | number, name: string, body: unknown) => { events.push({ target, name, body }); },
    chat: (target: 'all' | number, msg: { text: string }) => { chats.push({ target, text: msg.text }); },
    posOfPlayer: (id: number) => over.positions?.[id],
    players: () => Object.keys(over.positions ?? {}).map((id) => ({ id: Number(id), name: `P${id}`, rank: 0 })),
    partyOnline: () => over.party ?? [],
  } as unknown as PluginApi;
  return { api, events, chats, logs };
}

// OT3-176: the cell and the party hear it; a stranger elsewhere never does.
test('a death is told to the cell and the party, not the server', () => {
  const at = (cellKey: string) => ({ cellKey, x: 0, y: 0, z: 0 });
  const { api, chats } = fakeApi({ positions: { 1: at('a'), 2: at('a'), 3: at('b'), 4: at('c') }, party: [3] });
  respawn.onPlayerDeath!(api, DEAD);
  const told = chats.filter((c) => /Faller has fallen/.test(c.text)).map((c) => c.target).sort();
  assert.deepEqual(told, [1, 2, 3]);
  assert.ok(!chats.some((c) => c.target === 'all'));
});

// NEGATIVE CONTROL: alone, the operator's configured point is still honoured exactly as before.
test('solo: the configured respawn point is used', () => {
  const { api, events } = fakeApi({ positions: { 1: { cellKey: 'x', x: 9, y: 9, z: 9 } } });
  respawn.onPlayerDeath!(api, DEAD);
  const res = events.find((e) => e.name === 'PlayerResurrect');
  assert.deepEqual(res!.body, { cellKey: '26,25', x: 216831, y: 204909, z: 513, restoreHp: true });
});

// ...and with NO configured point, you come back where you fell rather than nowhere. Not ideal,
// but recoverable — and strictly better than a teleport to a coordinate from another game.
test('no configured point: back where you fell', () => {
  const here = { cellKey: 'balmora, guild of mages', x: 5, y: 6, z: 7 };
  const { api, events, logs } = fakeApi({ respawnCellKey: '', positions: { 1: here } });
  respawn.onPlayerDeath!(api, DEAD);
  assert.deepEqual(events[0]!.body, { ...here, restoreHp: true });
  // "" is the SHIPPED default (backlog 355): a valid choice, not a misconfiguration.
  assert.equal(logs.filter((l) => l.event.startsWith('respawn.') && l.event !== 'respawn.sent').length, 0,
    'where-you-fell is the default and must not warn');
});

// An operator who set the Example Suite village on real content chose it: honoured, no warning.
test('a configured point is honoured on real content too', () => {
  const { api, events, logs } = fakeApi({ simPeer: true, positions: { 1: { cellKey: 'x', x: 9, y: 9, z: 9 } } });
  respawn.onPlayerDeath!(api, DEAD);
  const res = events.find((e) => e.name === 'PlayerResurrect');
  assert.deepEqual(res!.body, { cellKey: '26,25', x: 216831, y: 204909, z: 513, restoreHp: true });
  assert.equal(logs.filter((l) => l.event.includes('demo')).length, 0);
});

// A drowning fell UNDER the water: put back on the seabed with full health it drowns again on
// the next breath (backlog 485: six deaths in three minutes). An exterior's water is at z = 0,
// so where-you-fell below it comes back at the surface of the same spot. An interior's water
// level is unknown to the server: there, where you fell stays where you fell.
test('no configured point, drowned outside: back at the surface of the same spot', () => {
  const seabed = { cellKey: '-3,-9', x: -19264, y: -72128, z: -1135 };
  const { api, events, logs } = fakeApi({ respawnCellKey: '', positions: { 1: seabed } });
  respawn.onPlayerDeath!(api, DEAD);
  assert.deepEqual(events[0]!.body, { ...seabed, z: 32, restoreHp: true });
  assert.equal(logs.find((l) => l.event === 'respawn.sent')!.fields!.via, 'surfaced');
});
test('no configured point, below zero indoors: where you fell, untouched', () => {
  const deep = { cellKey: 'vivec, underworks', x: 5, y: 6, z: -700 };
  const { api, events } = fakeApi({ respawnCellKey: '', positions: { 1: deep } });
  respawn.onPlayerDeath!(api, DEAD);
  assert.deepEqual(events[0]!.body, { ...deep, restoreHp: true });
});

// OT3-174: party revive and the nearest visited shrine.
function partyApi(over: {
  shrines?: { cellKey: string; x: number; y: number; z: number; ex?: number; ey?: number }[];
  outside?: { x: number; y: number };
  fell?: { cellKey: string; x: number; y: number; z: number };
  party?: number[];
}) {
  const f = fakeApi({ respawnCellKey: '', positions: over.fell ? { 1: over.fell } : {} });
  Object.assign(f.api, {
    partyOnline: (id: number) => (id === 1 ? over.party ?? [] : []),
    shrinesOf: () => ({ shrines: over.shrines ?? [], outside: over.outside }),
    maxHealthOf: () => 80,
  });
  return f;
}
const BALMORA = { cellKey: 'Balmora, Temple', x: 1, y: 2, z: 3, ex: -20000, ey: -12000 };
const ALDRUHN = { cellKey: 'Ald-ruhn, Temple', x: 4, y: 5, z: 6, ex: -16000, ey: 52000 };

test('unrevived, alone: back at the nearest visited shrine', () => {
  const { api, events } = partyApi({ shrines: [BALMORA, ALDRUHN], fell: { cellKey: '-2,6', x: -15000, y: 50000, z: 100 } });
  respawn.onPlayerDeath!(api, DEAD);
  const res = events.find((e) => e.name === 'PlayerResurrect');
  assert.deepEqual(res!.body, { cellKey: 'Ald-ruhn, Temple', x: 4, y: 5, z: 6, restoreHp: true });
});

test('dying indoors measures from the last outdoor spot they left', () => {
  const { api, events } = partyApi({
    shrines: [ALDRUHN, BALMORA], outside: { x: -21000, y: -11000 },
    fell: { cellKey: 'Balmora, Caius Cosades\' House', x: 0, y: 0, z: 0 },
  });
  respawn.onPlayerDeath!(api, DEAD);
  assert.equal((events.find((e) => e.name === 'PlayerResurrect')!.body as { cellKey: string }).cellKey, 'Balmora, Temple');
});

test('downed with a party: a party heal stands them up in place; a stranger\'s does not', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fell = { cellKey: '-2,6', x: -15000, y: 50000, z: 100 };
  const { api, events, chats } = partyApi({ shrines: [BALMORA], fell, party: [2] });
  respawn.onPlayerDeath!(api, DEAD);
  respawn.onPlayerDeath!(api, DEAD); // the client's 5 s resend
  assert.equal(events.filter((e) => e.name === 'PlayerResurrect').length, 0, 'no respawn while downed');
  assert.ok(chats.some((c) => c.target === 2 && /Faller is down/.test(c.text)), 'the party is told');
  assert.notEqual(respawn.onPlayerRevive!(api, { id: 9, name: 'Stranger', rank: 0 }, 1), true);
  assert.equal(respawn.onPlayerRevive!(api, { id: 2, name: 'Friend', rank: 0 }, 1), true);
  assert.deepEqual(events.find((e) => e.name === 'PlayerResurrect')!.body, { ...fell, standUp: true, hp: 20 });
  t.mock.timers.tick(30_000);
  assert.equal(events.filter((e) => e.name === 'PlayerResurrect').length, 1, 'the timer was cancelled');
});

test('downed and never revived: the shrine after the window, with all items', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { api, events } = partyApi({ shrines: [BALMORA], fell: { cellKey: '-3,-2', x: -20500, y: -12500, z: 0 }, party: [2] });
  respawn.onPlayerDeath!(api, DEAD);
  t.mock.timers.tick(29_999);
  assert.equal(events.length, 0);
  t.mock.timers.tick(1);
  const res = events.find((e) => e.name === 'PlayerResurrect')!.body as Record<string, unknown>;
  assert.equal(res.cellKey, 'Balmora, Temple');
  assert.equal(res.restoreHp, true); // nothing about inventory crosses: items stay where they are
  assert.equal(respawn.onPlayerRevive!(api, { id: 2, name: 'Friend', rank: 0 }, 1), undefined, 'too late to revive');
});
