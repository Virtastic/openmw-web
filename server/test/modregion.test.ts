// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-83: ModRegion (endgame blight) is saved, relayed and replayed; a script's ChangeWeather on
// a non-holder is forwarded to the region holder instead of being overwritten by its next say.

import test from 'node:test';
import assert from 'node:assert/strict';
import { WeatherRegions } from '../src/core/weather';
import { CellStore } from '../src/persist/cellstore';
import type { Player, Roster } from '../src/core/players';
import { tmpDataDir } from './helpers';

type Sent = { name: string; body: Record<string, unknown> };
function fakePlayer(id: number): Player {
  const sent: Sent[] = [];
  return {
    id, name: `P${id}`, accountKey: `p${id}`, inWorld: true,
    peer: { sendEvent: (name: string, body: Record<string, unknown>) => sent.push({ name, body }), sent },
  } as unknown as Player;
}
const sentOf = (p: Player) => (p.peer as unknown as { sent: Sent[] }).sent;
const named = (p: Player, name: string) => sentOf(p).filter((e) => e.name === name).map((e) => e.body);
const luaArray = (xs: number[]) => new Map<number, number>(xs.map((x, i) => [i + 1, x]));
const body = (entries: [string, unknown][]) => new Map<string, unknown>(entries) as never;

function harness(store: { weather: Record<string, never>; modRegions: Record<string, number[]> } = { weather: {}, modRegions: {} }) {
  const players = new Map<number, Player>();
  const roster = { get: (id: number) => players.get(id), inWorld: () => [...players.values()] } as unknown as Roster;
  let saves = 0;
  const weather = new WeatherRegions({ roster, weather: store.weather, modRegions: store.modRegions, save: () => { saves++; } });
  const add = (id: number) => { const p = fakePlayer(id); players.set(id, p); return p; };
  const enter = (p: Player, region: string) => weather.changeRegion(p, body([['region', region]]));
  return { weather, add, enter, store, saves: () => saves };
}

const BLIGHT = [0, 0, 0, 0, 0, 0, 0, 0, 100, 0];

test('ModRegion is saved, relayed to everyone else and replayed at join', async () => {
  const h = harness();
  const [a, b] = [h.add(1), h.add(2)];
  h.weather.handleModRegion(a, body([['region', 'red mountain region'], ['chances', luaArray(BLIGHT)]]));
  assert.deepEqual(h.store.modRegions['red mountain region'], BLIGHT);
  assert.equal(h.saves(), 1);
  assert.deepEqual(named(b, 'WorldModRegion'), [{ region: 'red mountain region', chances: BLIGHT }]);
  assert.deepEqual(named(a, 'WorldModRegion'), [], 'the sender already applied it');

  // A repeat (the same script re-running) neither saves nor relays again.
  h.weather.handleModRegion(a, body([['region', 'red mountain region'], ['chances', luaArray(BLIGHT)]]));
  assert.equal(h.saves(), 1);
  assert.equal(named(b, 'WorldModRegion').length, 1);

  const c = h.add(3);
  h.weather.sendSyncTo(c);
  assert.deepEqual(named(c, 'WorldModRegion'), [{ region: 'red mountain region', chances: BLIGHT }]);
});

test('malformed ModRegion bodies are dropped', () => {
  const h = harness();
  const [a, b] = [h.add(1), h.add(2)];
  for (const chances of [
    luaArray([]), luaArray([101]), luaArray([-1]), luaArray([1.5]), luaArray(new Array(11).fill(0)),
    new Map([[2, 5]]), 'x',
  ]) {
    h.weather.handleModRegion(a, body([['region', 'r'], ['chances', chances]]));
  }
  h.weather.handleModRegion(a, body([['region', ''], ['chances', luaArray(BLIGHT)]]));
  assert.deepEqual(h.store.modRegions, {});
  assert.deepEqual(named(b, 'WorldModRegion'), []);
});

test('a non-holder script ChangeWeather is forwarded to the holder, not lost', async () => {
  const h = harness();
  const [a, b] = [h.add(1), h.add(2)];
  h.enter(a, 'ascadian isles');
  h.enter(b, 'ascadian isles');
  await h.weather.drain();
  assert.equal(h.weather.holderOf('ascadian isles'), 1);

  h.weather.handleScriptWeather(b, body([['region', 'ascadian isles'], ['current', 4]]));
  await h.weather.drain();
  assert.deepEqual(named(a, 'WorldWeatherScript'), [{ region: 'ascadian isles', current: 4 }]);

  // The holder's own script change needs no forward: its tick says it.
  h.weather.handleScriptWeather(a, body([['region', 'ascadian isles'], ['current', 5]]));
  await h.weather.drain();
  assert.equal(named(a, 'WorldWeatherScript').length, 1);
  assert.equal(named(b, 'WorldWeatherScript').length, 0);
});

test('a script ChangeWeather for a region nobody holds becomes its saved weather', async () => {
  const h = harness();
  const [a, b] = [h.add(1), h.add(2)];
  h.weather.handleScriptWeather(a, body([['region', 'bitter coast region'], ['current', 2]]));
  await h.weather.drain();
  assert.deepEqual(h.weather.currentWeather('bitter coast region'), { current: 2 });
  assert.deepEqual(named(b, 'WorldWeather'), [{ region: 'bitter coast region', current: 2 }]);
  assert.deepEqual(named(a, 'WorldWeather'), []);
  // ...and the next claimant is handed it back.
  h.enter(b, 'bitter coast region');
  await h.weather.drain();
  assert.deepEqual(named(b, 'WorldWeather').at(-1), { region: 'bitter coast region', current: 2, restore: true });

  h.weather.handleScriptWeather(a, body([['region', 'x'], ['current', 999]]));
  await h.weather.drain();
  assert.equal(h.weather.currentWeather('x'), undefined);
});

test('ModRegion chances survive a server restart', async () => {
  const dir = tmpDataDir();
  let cs = new CellStore(dir);
  await cs.ready();
  const m7 = cs.worldM7();
  const h = harness({ weather: m7.weather as never, modRegions: (m7.modRegions ??= {}) });
  const a = h.add(1);
  h.weather.handleModRegion(a, body([['region', 'red mountain region'], ['chances', luaArray(BLIGHT)]]));
  cs.saveShared();
  await cs.close();

  cs = new CellStore(dir);
  await cs.ready();
  assert.deepEqual(cs.worldM7().modRegions, { 'red mountain region': BLIGHT });
  const after = harness({ weather: cs.worldM7().weather as never, modRegions: cs.worldM7().modRegions! });
  const b = after.add(2);
  after.weather.sendSyncTo(b);
  assert.deepEqual(named(b, 'WorldModRegion'), [{ region: 'red mountain region', chances: BLIGHT }]);
  await cs.close();
});
