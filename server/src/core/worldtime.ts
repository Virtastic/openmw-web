// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M7 server-owned clock (PROTOCOL.md §M7). The server is the ONLY writer of game time:
// clients slew towards WorldTime rather than snapping, and never send the time globals
// (M6 drops GameHour/Day/Month/Year/DaysPassed from GlobalVarUpdate for exactly this
// reason). A WorldTimeRequest — one player resting or waiting — is applied here and
// rebroadcast, so time advances for EVERYONE at once.
//
// The clock free-runs off real elapsed wall time scaled by timeScale, is broadcast on
// every change and at least every 60 s, and is persisted in world/global.json so a
// restart resumes the calendar instead of resetting to day one.

import type { LTable, LValue, JsLike } from '../proto/lser';
import type { WorldTimeState } from '../persist/cellstore';
import { log } from '../log';

const BROADCAST_MS = 60_000;
const TICK_MS = 1_000;
// A single rest/wait may not skip more than a month; a script loop that asks for a
// million hours is a bug or an attack, not gameplay.
const MAX_ADVANCE_HOURS = 30 * 24;
const REASONS = new Set(['rest', 'wait', 'script']);
// Morrowind's calendar (Sun's Dawn is 28 days; no leap years in-game).
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// Phase 2.5: who may skip time, and by how much.
//   'anyone'  M7 behaviour — any rest/wait advances the shared clock for everybody
//   'owner'   only the world's owner may skip (guests must not fast-forward the host's game).
//             'party' is the legacy spelling and means the same thing.
//   'off'     nobody; time flows continuously
export type TimeSkipPolicy = 'anyone' | 'owner' | 'party' | 'off';

export interface ClockCtx {
  state: WorldTimeState; // lives in the CellStore global doc; mutated in place
  save(): void; // schedule the atomic global.json write
  broadcast(body: JsLike): void; // WorldTime to everyone in-world
}

export class WorldClock {
  private timer?: NodeJS.Timeout;
  private lastRealMs = Date.now();
  private lastBroadcastMs = 0;

  constructor(private readonly ctx: ClockCtx) {}

  start(): void {
    if (this.timer) return;
    this.lastRealMs = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref(); // never hold the process (or a test) open
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  body(): JsLike {
    const t = this.ctx.state;
    return {
      gameHour: Math.round(t.gameHour * 1e4) / 1e4,
      day: t.day,
      month: t.month,
      year: t.year,
      timeScale: t.timeScale,
    };
  }

  // Late joiner / resync: the clock is part of the world snapshot.
  sendTo(send: (name: string, body: JsLike) => void): void {
    send('WorldTime', this.body());
  }

  // Free-run: consume real elapsed time, then broadcast on the 60 s heartbeat.
  private tick(): void {
    const now = Date.now();
    const elapsedSec = Math.max(0, (now - this.lastRealMs) / 1000);
    this.lastRealMs = now;
    if (this.ctx.state.timeScale > 0 && elapsedSec > 0) {
      this.addHours((elapsedSec * this.ctx.state.timeScale) / 3600);
    }
    if (now - this.lastBroadcastMs >= BROADCAST_MS) this.publish(now);
  }

  private publish(now = Date.now()): void {
    this.lastBroadcastMs = now;
    this.ctx.save();
    this.ctx.broadcast(this.body());
  }

  // Normalizing add. Hours may be fractional; day/month/year roll over the MW calendar.
  private addHours(hours: number): void {
    const t = this.ctx.state;
    t.gameHour += hours;
    let guard = 0;
    while (t.gameHour >= 24 && guard++ < MAX_ADVANCE_HOURS + 32) {
      t.gameHour -= 24;
      t.day += 1;
      const len = MONTH_DAYS[t.month - 1] ?? 30;
      if (t.day > len) {
        t.day = 1;
        t.month += 1;
        if (t.month > 12) {
          t.month = 1;
          t.year += 1;
        }
      }
    }
  }

  // Operator/plugin entry point (also used by the request path). Broadcasts immediately.
  advance(hours: number): void {
    this.addHours(hours);
    this.publish();
  }

  setTimeScale(scale: number): void {
    if (!Number.isFinite(scale) || scale < 0 || scale > 10_000) return;
    this.ctx.state.timeScale = scale;
    this.publish();
  }

  // C->S WorldTimeRequest {advanceHours, reason}. Validated and warn+dropped on garbage:
  // a malformed frame must cost only the sender, never the shared clock.
  request(who: string, body: LTable): void {
    const hours = body.get('advanceHours');
    const reason = body.get('reason');
    if (
      typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > MAX_ADVANCE_HOURS ||
      typeof reason !== 'string' || !REASONS.has(reason)
    ) {
      log('warn', 'time.request_dropped', { from: who, hours: String(hours as LValue), reason: String(reason as LValue) });
      return;
    }
    log('info', 'time.advance', { from: who, hours, reason });
    this.advance(hours);
  }
}
