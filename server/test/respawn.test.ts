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
  } as unknown as PluginApi;
  return { api, events, chats, logs };
}

test('the world is TOLD about a death', () => {
  const { api, chats } = fakeApi({
    positions: { 2: { cellKey: 'a', x: 0, y: 0, z: 0 } },
  });
  respawn.onPlayerDeath!(api, DEAD);
  assert.ok(chats.length >= 1, 'the death is announced');
  assert.match(chats[0]!.text, /Faller has fallen/);
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
