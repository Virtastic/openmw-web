// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M7 per-region weather authority (PROTOCOL.md §M7). Exactly the M4 cell-authority
// problem with the key swapped from cellKey to region, so it REUSES core/authority.ts
// unchanged rather than cloning the state machine: one holder per region simulates the
// weather sim, the longest-present occupant inherits on handoff, an empty region folds
// its last state and goes dormant, and the next claimant is handed that state back so
// weather CONTINUES across a dormancy instead of rerolling.
//
// Two deliberate differences from cells, both invisible to authority.ts:
//   * the wire message is the single `WorldWeatherAuthority {region, holderId}` §M7
//     specifies — grant/info both emit it, and a revoke emits holderId=0 ("nobody");
//     the epoch stays server-internal (weather has no per-object addressing to guard).
//   * the "snapshot" is the region's last WorldWeather body, folded to global.json.
//
// Region membership is NOT derivable from cellKey server-side (cell->region lives in the
// content files), so the client declares it with `WorldRegionChange {region}`.

import type { LTable, LValue, JsLike } from '../proto/lser';
import { Authority } from './authority';
import type { Player, Roster } from './players';
import type { WeatherState } from '../persist/cellstore';
import { log } from '../log';

const MAX_REGION = 64;
const MAX_WEATHER_ID = 255;

export interface WeatherCtx {
  roster: Roster;
  weather: Record<string, WeatherState>; // lives in the CellStore global doc
  save(): void;
}

function region(v: LValue | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_REGION ? v : undefined;
}

function weatherId(v: LValue | undefined): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_WEATHER_ID ? v : undefined;
}

export class WeatherRegions {
  private readonly authority: Authority;
  private queue: Promise<void> = Promise.resolve();
  // playerId -> region they last declared (needed to leave on change/disconnect).
  private playerRegion = new Map<number, string>();

  constructor(private readonly ctx: WeatherCtx) {
    this.authority = new Authority({
      grant: (playerId, key, _epoch, snapshot) => {
        this.send(playerId, 'WorldWeatherAuthority', { region: key, holderId: playerId });
        // Continuity: hand the new holder the region's last known weather.
        //
        // MARKED `restore`, and it has to be. The client drops any WorldWeather for a region it
        // holds — correctly, so a holder never applies its own echo back onto itself — and this
        // message arrives just AFTER the grant that made it the holder. Unmarked it is
        // indistinguishable from an echo and is thrown away by the one client it was meant for,
        // so the region keeps whatever weather that client happened to roll at boot. For a solo
        // player that is a fresh roll every session, which is exactly the "weather is randomised
        // on each load" report.
        const state = snapshot as WeatherState | undefined;
        if (state && typeof state.current === 'number') {
          this.send(playerId, 'WorldWeather', { region: key, ...stateBody(state), restore: true });
        }
      },
      // holderId 0 is never a valid playerId (the roster allocates from 1) and reads as
      // "this region currently has no authority".
      revoke: (playerId, key) => this.send(playerId, 'WorldWeatherAuthority', { region: key, holderId: 0 }),
      info: (playerId, key, holderId) => this.send(playerId, 'WorldWeatherAuthority', { region: key, holderId }),
      loadOverrides: async (key) => (this.ctx.weather[key] ?? null) as unknown as JsLike,
      foldOverrides: async (key, snapshot) => {
        const state = snapshot as WeatherState | undefined;
        if (state && typeof state.current === 'number') {
          this.ctx.weather[key] = state;
          this.ctx.save();
        }
      },
    },
    // No fitness sweep for regions: the weather holder only forwards its own weather
    // packet, so it costs nothing to be a slow one — and every handoff re-broadcasts
    // WorldWeatherAuthority to a whole region for no gain.
    { review: false });
  }

  private send(playerId: number, name: string, body: JsLike): void {
    this.ctx.roster.get(playerId)?.peer.sendEvent(name, body);
  }

  private enqueue(fn: () => Promise<void> | void): void {
    this.queue = this.queue.then(fn).catch((err) => log('error', 'weather.op_failed', { error: String(err) }));
  }

  drain(): Promise<void> {
    return this.queue;
  }

  holderOf(regionName: string): number | undefined {
    return this.authority.holderOf(regionName);
  }

  regionOf(playerId: number): string | undefined {
    return this.playerRegion.get(playerId);
  }

  currentWeather(regionName: string): WeatherState | undefined {
    return this.ctx.weather[regionName];
  }

  // C->S WorldRegionChange {region}: occupancy move, serialized so contested entry
  // resolves first-processed-wins exactly like cells.
  changeRegion(player: Player, body: LTable): void {
    const to = region(body.get('region'));
    if (!to) {
      log('warn', 'weather.bad_region_change', { from: player.name });
      return;
    }
    const playerId = player.id;
    const from = this.playerRegion.get(playerId);
    if (from === to) return;
    this.playerRegion.set(playerId, to);
    this.enqueue(async () => {
      if (from) await this.authority.onLeave(playerId, from, true);
      await this.authority.onEnter(playerId, to);
    });
  }

  // Disconnect teardown (no Revoke — the socket is gone).
  onDisconnect(playerId: number): void {
    const from = this.playerRegion.get(playerId);
    this.playerRegion.delete(playerId);
    if (from) this.enqueue(() => this.authority.onLeave(playerId, from, false));
  }

  // C->S WorldWeather from the region holder; S->C broadcast to everyone else.
  handleWeather(player: Player, body: LTable): void {
    const name = region(body.get('region'));
    const current = weatherId(body.get('current'));
    const rawNext = body.get('next');
    const next = rawNext === undefined ? undefined : weatherId(rawNext);
    const rawTransition = body.get('transition');
    const transition = rawTransition === undefined ? undefined
      : typeof rawTransition === 'number' && Number.isFinite(rawTransition) && rawTransition >= 0 && rawTransition <= 1
        ? rawTransition : undefined;
    if (
      !name || current === undefined ||
      (rawNext !== undefined && next === undefined) ||
      (rawTransition !== undefined && transition === undefined)
    ) {
      log('warn', 'weather.dropped', { from: player.name, why: 'invalid shape' });
      return;
    }
    this.enqueue(() => {
      if (this.authority.holderOf(name) !== player.id) {
        log('warn', 'weather.dropped', { from: player.name, region: name, why: 'not the region authority' });
        return;
      }
      const state: WeatherState = {
        current,
        ...(next !== undefined ? { next } : {}),
        ...(transition !== undefined ? { transition } : {}),
      };
      this.ctx.weather[name] = state;
      this.authority.setSnapshot(name, state as unknown as JsLike);
      this.ctx.save();
      const out = { region: name, ...stateBody(state) };
      for (const p of this.ctx.roster.inWorld()) if (p.id !== player.id) p.peer.sendEvent('WorldWeather', out);
    });
  }

  // Join: replay every known region's weather so a fresh client isn't blank until the
  // holder's next transition (which can be many minutes out).
  sendSyncTo(player: Player): void {
    for (const [name, state] of Object.entries(this.ctx.weather)) {
      player.peer.sendEvent('WorldWeather', { region: name, ...stateBody(state) });
    }
  }
}

function stateBody(state: WeatherState): Record<string, JsLike> {
  return {
    current: state.current,
    ...(state.next !== undefined ? { next: state.next } : {}),
    ...(state.transition !== undefined ? { transition: state.transition } : {}),
  };
}
