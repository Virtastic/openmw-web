// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// WHERE YOU COME BACK, which is a gameplay decision rather than a technicality.
//
// It used to be an unconditional teleport to [rules] respawnCellKey, whose shipped default is the
// EXAMPLE SUITE demo's village — a coordinate from a different game world. On retail Morrowind
// that is an arbitrary point on the grid, so every death threw the player somewhere meaningless,
// and nothing in the deploy docs or the logs ever said so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { respawn } from '../src/plugins/builtin/respawn';
import type { PluginApi, PluginPlayer } from '../src/plugins/api';
import type { Config } from '../src/config';

const DEAD: PluginPlayer = { id: 1, name: 'Faller', rank: 0 };

function fakeApi(over: {
  party?: number[];
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
    partyOfPlayer: () => over.party ?? [],
    posOfPlayer: (id: number) => over.positions?.[id],
  } as unknown as PluginApi;
  return { api, events, chats, logs };
}

test('a dead player comes back with their PARTY, not across the map', () => {
  const mate = { cellKey: 'bloodmoon, mine', x: 10, y: 20, z: 30 };
  const { api, events } = fakeApi({
    party: [2],
    positions: { 1: { cellKey: 'bloodmoon, mine', x: 11, y: 21, z: 31 }, 2: mate },
  });
  respawn.onPlayerDeath!(api, DEAD);
  const res = events.find((e) => e.name === 'PlayerResurrect');
  assert.ok(res, 'a resurrect was sent');
  assert.deepEqual(res.body, { ...mate, restoreHp: true },
    'sent to the configured point instead of to the party — that is a ten-minute walk back');
});

test('the party is TOLD, which nothing did before', () => {
  const { api, chats } = fakeApi({
    party: [2, 3],
    positions: { 2: { cellKey: 'a', x: 0, y: 0, z: 0 } },
  });
  respawn.onPlayerDeath!(api, DEAD);
  assert.equal(chats.length, 2, 'every party member hears it');
  assert.match(chats[0]!.text, /Faller has fallen/);
});

// NEGATIVE CONTROL: alone, the operator's configured point is still honoured exactly as before.
test('solo: the configured respawn point is used', () => {
  const { api, events } = fakeApi({ party: [], positions: { 1: { cellKey: 'x', x: 9, y: 9, z: 9 } } });
  respawn.onPlayerDeath!(api, DEAD);
  const res = events.find((e) => e.name === 'PlayerResurrect');
  assert.deepEqual(res!.body, { cellKey: '26,25', x: 216831, y: 204909, z: 513, restoreHp: true });
});

// ...and with NO configured point, you come back where you fell rather than nowhere. Not ideal,
// but recoverable — and strictly better than a teleport to a coordinate from another game.
test('no party and no configured point: back where you fell', () => {
  const here = { cellKey: 'balmora, guild of mages', x: 5, y: 6, z: 7 };
  const { api, events } = fakeApi({ party: [], respawnCellKey: '', positions: { 1: here } });
  respawn.onPlayerDeath!(api, DEAD);
  assert.deepEqual(events[0]!.body, { ...here, restoreHp: true });
});

// THE WARNING THAT WOULD HAVE CAUGHT THIS. A world running real game data with the demo's
// coordinate still set is misconfigured, and it is invisible until somebody dies.
test('boot warns when a real world still has the demo respawn point', () => {
  const { api, logs } = fakeApi({ simPeer: true });
  respawn.onServerStart!(api);
  assert.ok(logs.some((l) => l.event === 'respawn.demo_default_on_real_world'),
    'a retail server silently kept the Example Suite village as its respawn point');
});

test('...and does not warn on the demo itself', () => {
  const { api, logs } = fakeApi({ simPeer: false });
  respawn.onServerStart!(api);
  assert.equal(logs.filter((l) => l.event === 'respawn.demo_default_on_real_world').length, 0);
});
