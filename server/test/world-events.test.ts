// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-200: open-world events start on schedule and pay on participation, not last hit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { worldEvents, activeEvent, busiestRegion, spawnsFor, KILL_POINTS } from '../src/plugins/builtin/world-events';
import type { PluginApi } from '../src/plugins/api';
import type { Config } from '../src/config';

const MIN = 60_000;

function fakeApi(over: { enabled?: boolean; peerHolds?: boolean; threshold?: number } = {}) {
  const region: Record<number, string | undefined> = { 1: 'Ashlands Region', 2: 'Ashlands Region', 3: 'Ashlands Region', 4: 'Bitter Coast Region' };
  const cell: Record<number, string> = { 1: '2,4', 2: '2,5', 3: 'Maar Gan, Shrine', 4: '-5,-5' };
  const online = new Set([1, 2, 3, 4]);
  const spawns: { id: number; recordId: string; count: number }[] = [];
  const weather: { region: string; id: number }[] = [];
  const gives: { id: number; count: number }[] = [];
  const chats: { target: 'all' | number; text: string }[] = [];
  const claims = new Set<string>();
  const api = {
    config: { worldEvents: {
      enabled: over.enabled ?? true, intervalMin: 120, durationMin: 15, minPlayers: 1,
      threshold: over.threshold ?? 5, rewardGold: 200, spawnCount: 3, kinds: ['sixthhouse', 'daedric', 'blight'], spawns: [],
    } } as unknown as Config,
    log: () => {},
    players: () => [...online].map((id) => ({ id, name: `P${id}`, rank: 0 })),
    chat: (target: 'all' | number, msg: { text: string }) => { chats.push({ target, text: msg.text }); },
    regionOf: (id: number) => region[id],
    cellOfPlayer: (id: number) => cell[id],
    spawnNear: (id: number, recordId: string, count: number) => { if (over.peerHolds === false) return false; spawns.push({ id, recordId, count }); return true; },
    world: { forceWeather: (r: string, id: number) => { weather.push({ region: r, id }); } },
    give: (id: number, _r: string, count: number) => { gives.push({ id, count }); },
    claimOnce: (id: number, key: string) => { const k = `${id}|${key}`; if (claims.has(k)) return false; claims.add(k); return true; },
  } as unknown as PluginApi;
  return { api, spawns, weather, gives, chats, online, region };
}

test('busiest region; spawn lists can be replaced', () => {
  const { api } = fakeApi();
  assert.equal(busiestRegion(api), 'Ashlands Region');
  assert.deepEqual(spawnsFor('daedric', ['daedric=scamp, Dremora_Lord']), ['scamp', 'dremora_lord']);
  assert.deepEqual(spawnsFor('blight', ['daedric=scamp']), spawnsFor('blight', []));
});

test('an event starts on schedule, rewards everyone above the threshold, and not the idle', () => {
  const t0 = 1_000_000_000;
  const { api, spawns, weather, gives, chats } = fakeApi();
  worldEvents.onTick!(api, t0); // first sight: schedules the first start one interval out
  assert.equal(activeEvent(api), undefined);
  worldEvents.onTick!(api, t0 + 119 * MIN);
  assert.equal(activeEvent(api), undefined, 'not before its time');
  worldEvents.onTick!(api, t0 + 120 * MIN);
  const ev = activeEvent(api);
  assert.ok(ev, 'started on schedule');
  assert.equal(ev.kind, 'sixthhouse');
  assert.equal(ev.region, 'Ashlands Region');
  // Spawned beside the two players OUTDOORS in the region only; the ash storm is forced.
  assert.deepEqual(spawns.map((s) => s.id).sort(), [1, 2]);
  assert.deepEqual(weather, [{ region: 'Ashlands Region', id: 6 }]);
  assert.ok(chats.some((c) => c.target === 3) && !chats.some((c) => c.target === 4), 'the region hears it, not elsewhere');

  // Player 1 kills two raiders that player 2 sees; player 4 (other region) sees one too.
  const start = t0 + 120 * MIN;
  worldEvents.onActorKilled!(api, { recordId: 'ash_slave', cellKey: '2,4', killerId: 1, witnesses: [1, 2, 4] });
  worldEvents.onActorKilled!(api, { recordId: 'ash_zombie', cellKey: '2,4', killerId: 1, witnesses: [1, 2] });
  worldEvents.onActorKilled!(api, { recordId: 'rat', cellKey: '2,4', killerId: 2, witnesses: [1, 2] }); // not an event creature
  assert.equal(ev.score.get(1), 2 * KILL_POINTS);
  assert.equal(ev.score.get(2), 2);
  assert.equal(ev.score.get(4), undefined);
  // Fifteen minutes later: 15 presence points for everyone in the region (3 included, indoors).
  worldEvents.onTick!(api, start + 15 * MIN);
  assert.equal(activeEvent(api), undefined, 'over');
  assert.deepEqual(gives.map((g) => g.id).sort(), [1, 2, 3]);
  assert.ok(gives.every((g) => g.count === 200));
});

test('below the threshold nobody is paid; no sim peer means no event; disabled does nothing', () => {
  const t0 = 2_000_000_000;
  const a = fakeApi({ threshold: 1000 });
  worldEvents.onTick!(a.api, t0);
  worldEvents.onTick!(a.api, t0 + 120 * MIN);
  worldEvents.onTick!(a.api, t0 + 140 * MIN);
  assert.equal(a.gives.length, 0);
  assert.ok(a.chats.some((c) => /did not do enough/.test(c.text)));

  const b = fakeApi({ peerHolds: false });
  worldEvents.onTick!(b.api, t0);
  worldEvents.onTick!(b.api, t0 + 120 * MIN);
  assert.equal(activeEvent(b.api), undefined);
  assert.equal(b.weather.length, 0, 'no sky change without creatures');

  const c = fakeApi({ enabled: false });
  worldEvents.onTick!(c.api, t0);
  worldEvents.onTick!(c.api, t0 + 500 * MIN);
  assert.equal(activeEvent(c.api), undefined);
});
