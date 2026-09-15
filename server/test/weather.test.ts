// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// #53: a weather holder that goes indoors stops re-saying its weather (the engine stops the
// outdoor sim in an interior) but never declares a region change, so the region froze for
// everyone outside. After 3x the 60 s re-say with no WorldWeather, the seat is released and
// the longest-present other occupant inherits; a lone silent holder keeps it (nothing to gain).

import test from 'node:test';
import assert from 'node:assert/strict';
import { WeatherRegions, HOLDER_SILENCE_MS } from '../src/core/weather';
import type { Player, Roster } from '../src/core/players';

function fakePlayer(id: number): Player {
  const sent: { name: string; body: Record<string, unknown> }[] = [];
  return {
    id, name: `P${id}`, accountKey: `p${id}`, inWorld: true,
    peer: { sendEvent: (name: string, body: Record<string, unknown>) => sent.push({ name, body }), sent },
  } as unknown as Player;
}
const sentOf = (p: Player) => (p.peer as unknown as { sent: { name: string; body: Record<string, unknown> }[] }).sent;
const lastAuthority = (p: Player) => sentOf(p).filter((e) => e.name === 'WorldWeatherAuthority').at(-1)?.body;

function harness() {
  let now = 1_000_000;
  const players = new Map<number, Player>();
  const roster = {
    get: (id: number) => players.get(id),
    inWorld: () => [...players.values()],
  } as unknown as Roster;
  const weather = new WeatherRegions({ roster, weather: {}, save: () => {}, now: () => now });
  const add = (id: number) => { const p = fakePlayer(id); players.set(id, p); return p; };
  const tick = (ms: number) => { now += ms; weather.sweepSilent(); return weather.drain(); };
  const say = (p: Player, region: string) =>
    weather.handleWeather(p, new Map<string, unknown>([['region', region], ['current', 3]]) as never);
  const enter = (p: Player, region: string) =>
    weather.changeRegion(p, new Map<string, unknown>([['region', region]]) as never);
  return { weather, add, tick, say, enter };
}

test('a silent holder with company hands the region to the longest-present occupant', async () => {
  const h = harness();
  const [a, b, c] = [h.add(1), h.add(2), h.add(3)];
  h.enter(a, 'Ascadian Isles');
  await h.tick(10_000);
  h.enter(b, 'Ascadian Isles');
  await h.tick(10_000);
  h.enter(c, 'Ascadian Isles');
  await h.tick(0);
  assert.equal(h.weather.holderOf('Ascadian Isles'), 1);

  // The holder keeps talking: no handoff however long it goes on.
  for (let i = 0; i < 5; i++) { h.say(a, 'Ascadian Isles'); await h.tick(60_000); }
  assert.equal(h.weather.holderOf('Ascadian Isles'), 1, 'a talking holder is never replaced');

  // Then it goes indoors and says nothing for three re-say periods.
  await h.tick(HOLDER_SILENCE_MS - 1);
  assert.equal(h.weather.holderOf('Ascadian Isles'), 1, 'not yet');
  await h.tick(1);
  assert.equal(h.weather.holderOf('Ascadian Isles'), 2, 'the longest-present other occupant inherits');
  assert.deepEqual(lastAuthority(b), { region: 'Ascadian Isles', holderId: 2 });
  assert.deepEqual(lastAuthority(a), { region: 'Ascadian Isles', holderId: 2 }, 'the old holder is told who holds it now');
  assert.deepEqual(lastAuthority(c), { region: 'Ascadian Isles', holderId: 2 });

  // The old holder's late weather packet is now a non-holder's and is dropped.
  const heard = (p: Player) => sentOf(p).filter((e) => e.name === 'WorldWeather').length;
  const [bBefore, cBefore] = [heard(b), heard(c)];
  h.say(a, 'Ascadian Isles');
  await h.tick(0);
  assert.equal(heard(b), bBefore);
  // The new holder's is relayed.
  h.say(b, 'Ascadian Isles');
  await h.tick(0);
  assert.equal(heard(c), cBefore + 1);
});

test('a lone silent holder keeps the seat', async () => {
  const h = harness();
  const a = h.add(1);
  h.enter(a, 'Sheogorad');
  await h.tick(0);
  const before = sentOf(a).length;
  await h.tick(HOLDER_SILENCE_MS * 3);
  assert.equal(h.weather.holderOf('Sheogorad'), 1);
  assert.equal(sentOf(a).length, before, 'no churn for a solo player indoors');
});

test('the silence clock is per region and restarts on a grant', async () => {
  const h = harness();
  const [a, b] = [h.add(1), h.add(2)];
  h.enter(a, 'Ascadian Isles');
  h.enter(b, 'Ascadian Isles');
  await h.tick(0);
  await h.tick(HOLDER_SILENCE_MS);
  assert.equal(h.weather.holderOf('Ascadian Isles'), 2);
  // B inherited just now: it gets its own full silence window before being judged.
  await h.tick(HOLDER_SILENCE_MS - 1);
  assert.equal(h.weather.holderOf('Ascadian Isles'), 2);
  await h.tick(1);
  assert.equal(h.weather.holderOf('Ascadian Isles'), 1, 'and hands back when it too goes quiet');
});
