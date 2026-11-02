// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-200: open-world events. Every [worldEvents] intervalMin the server starts one in the
// busiest weather region (the region players declare, core/weather.ts) and runs it for
// durationMin:
//   - blight storm: the region's sky turns to Blight and blighted beasts come out;
//   - Daedric incursion: daedra step through beside the players there;
//   - Sixth House raid: an ash storm, and Dagoth's ash creatures with it.
// The creatures are spawned by the region's SIM PEER beside a player standing outdoors there
// (the QuestSpawn path a script's PlaceAtPC already uses), so they are real net actors anyone
// nearby can fight; weather goes out as a WorldWeather `restore`, which the holder applies too.
// PARTICIPATION, NOT LAST HIT: a kill of an event creature scores KILL_POINTS for the killer
// and WITNESS_POINTS for each human who saw it (worldstate's witness list), and every minute
// spent in the region during the event scores one. Everyone at or above `threshold` is paid
// at the end, once per character per event. Off by default: it spawns hostiles and pays gold.
// ponytail: one event at a time, in memory; a restart mid-event drops it unpaid.

import type { Plugin, PluginApi, PluginKill } from '../api';

export type EventKind = 'blight' | 'daedric' | 'sixthhouse';
export const KILL_POINTS = 3;
export const WITNESS_POINTS = 1;
const MINUTE = 60_000;
const EXTERIOR = /^-?\d+,-?\d+$/;

// Weather ids are the 0-based vanilla order the wire uses (world.lua buildWeatherIndex):
// 6 = Ashstorm, 7 = Blight. Creature ids: dremora, scamp, clannfear, ash_slave, ash_zombie and
// ash_ghoul are vanilla Morrowind.esm; the blighted variants' exact ids are the least certain
// (see the commit) and every list can be replaced with [worldEvents] spawns.
export const KINDS: Record<EventKind, { name: string; weather?: number; spawns: string[]; start: string; end: string }> = {
  blight: {
    name: 'blight storm', weather: 7, spawns: ['rat_blighted', 'cliff racer_blighted', 'kagouti_blighted'],
    start: 'A blight storm is rolling in over the %r, and the beasts are sick and mad with it.',
    end: 'The blight storm over the %r has blown itself out.',
  },
  daedric: {
    name: 'Daedric incursion', spawns: ['scamp', 'clannfear', 'dremora'],
    start: 'The veil is thin in the %r: daedra are coming through.',
    end: 'The Daedric incursion in the %r is over.',
  },
  sixthhouse: {
    name: 'Sixth House raid', weather: 6, spawns: ['ash_slave', 'ash_zombie', 'ash_ghoul'],
    start: 'Ash on the wind over the %r: the Sixth House is raiding.',
    end: 'The Sixth House raiders in the %r are scattered.',
  },
};

export interface ActiveEvent {
  id: number; kind: EventKind; region: string; endsAt: number; spawns: Set<string>;
  score: Map<number, number>; lastPresence: number;
}
interface State { next: number; seq: number; active?: ActiveEvent }
const stateBy = new WeakMap<PluginApi, State>();

/** [worldEvents] spawns entries "kind=id,id" replace that kind's creature list. */
export function spawnsFor(kind: EventKind, overrides: string[]): string[] {
  for (const o of overrides) {
    const m = /^(\w+)=(.+)$/.exec(o.trim());
    if (m?.[1] === kind) return m[2]!.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  return KINDS[kind].spawns;
}

const regionName = (r: string) => r.replace(/\b\w/g, (c) => c.toUpperCase());

function inRegion(api: PluginApi, region: string): number[] {
  return api.players().map((p) => p.id).filter((id) => api.regionOf?.(id) === region);
}

/** The region with most players in it (ties: first seen), or undefined. */
export function busiestRegion(api: PluginApi): string | undefined {
  const n = new Map<string, number>();
  for (const p of api.players()) {
    const r = api.regionOf?.(p.id);
    if (r) n.set(r, (n.get(r) ?? 0) + 1);
  }
  let best: string | undefined, most = 0;
  for (const [r, c] of n) if (c > most) { best = r; most = c; }
  return best;
}

export function startEvent(api: PluginApi, nowMs: number, kind: EventKind, region: string): ActiveEvent | undefined {
  const cfg = api.config.worldEvents;
  const st = stateOf(api, nowMs);
  const here = inRegion(api, region);
  // Spawned beside players standing OUTDOORS in the region: an interior is not the region's sky.
  const anchors = here.filter((id) => EXTERIOR.test(api.cellOfPlayer?.(id) ?? ''));
  if (anchors.length === 0) return undefined;
  const spawns = spawnsFor(kind, cfg.spawns);
  let placed = 0;
  for (const [i, id] of anchors.slice(0, 4).entries()) {
    const recordId = spawns[i % spawns.length];
    if (recordId && api.spawnNear?.(id, recordId, Math.max(1, cfg.spawnCount))) placed++;
  }
  if (placed === 0) return undefined; // nobody's cell is simulated: no event without its creatures
  const k = KINDS[kind];
  if (k.weather !== undefined) api.world.forceWeather?.(region, k.weather);
  const ev: ActiveEvent = {
    id: nowMs, kind, region, endsAt: nowMs + cfg.durationMin * MINUTE, spawns: new Set(spawns),
    score: new Map(), lastPresence: nowMs,
  };
  st.active = ev;
  const text = `${k.start.replace('%r', regionName(region))} Anyone there can join; everyone who helps is rewarded.`;
  for (const id of here) api.chat(id, { channel: 'server', text });
  api.log('info', 'worldevent.start', { kind, region, players: here.length, placed });
  return ev;
}

function endEvent(api: PluginApi, st: State): void {
  const ev = st.active;
  if (!ev) return;
  st.active = undefined;
  const cfg = api.config.worldEvents;
  const k = KINDS[ev.kind];
  const online = new Set(api.players().map((p) => p.id));
  const paid: number[] = [];
  for (const [id, pts] of ev.score) {
    if (!online.has(id)) continue;
    if (pts < cfg.threshold) {
      api.chat(id, { channel: 'server', text: `${k.end.replace('%r', regionName(ev.region))} You did not do enough to share the reward (${pts}/${cfg.threshold}).` });
      continue;
    }
    if (api.claimOnce && !api.claimOnce(id, `worldevent:${ev.id}`)) continue;
    paid.push(id);
    api.chat(id, { channel: 'server', text: k.end.replace('%r', regionName(ev.region)) });
    if (cfg.rewardGold > 0) api.give?.(id, 'gold_001', cfg.rewardGold, `For your part against the ${k.name}: ${cfg.rewardGold} gold.`, `worldevent:${ev.kind}`);
  }
  api.log('info', 'worldevent.end', { kind: ev.kind, region: ev.region, paid, scored: ev.score.size });
}

function stateOf(api: PluginApi, nowMs: number): State {
  let st = stateBy.get(api);
  if (!st) stateBy.set(api, (st = { next: nowMs + api.config.worldEvents.intervalMin * MINUTE, seq: 0 }));
  return st;
}

/** Test seam: the event in progress. */
export const activeEvent = (api: PluginApi): ActiveEvent | undefined => stateBy.get(api)?.active;

const add = (ev: ActiveEvent, id: number, pts: number) => ev.score.set(id, (ev.score.get(id) ?? 0) + pts);

export const worldEvents: Plugin = {
  name: 'world-events',
  onTick(api, nowMs) {
    const cfg = api.config.worldEvents;
    if (!cfg.enabled) return;
    const st = stateOf(api, nowMs);
    const ev = st.active;
    if (ev) {
      // Presence: a point a minute for being in the region while it lasts.
      while (nowMs - ev.lastPresence >= MINUTE) {
        ev.lastPresence += MINUTE;
        for (const id of inRegion(api, ev.region)) add(ev, id, 1);
      }
      if (nowMs >= ev.endsAt) endEvent(api, st);
      return;
    }
    if (nowMs < st.next) return;
    st.next = nowMs + cfg.intervalMin * MINUTE;
    const region = busiestRegion(api);
    const kinds = (cfg.kinds.filter((k) => k in KINDS) as EventKind[]);
    if (!region || kinds.length === 0 || inRegion(api, region).length < Math.max(1, cfg.minPlayers)) return;
    const kind = kinds[st.seq++ % kinds.length]!;
    startEvent(api, nowMs, kind, region);
  },
  onActorKilled(api, kill: PluginKill) {
    const ev = activeEvent(api);
    if (!ev || !ev.spawns.has(kill.recordId)) return;
    for (const id of kill.witnesses) {
      if (api.regionOf?.(id) !== ev.region) continue;
      add(ev, id, id === kill.killerId ? KILL_POINTS : WITNESS_POINTS);
    }
  },
};
