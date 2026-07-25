// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M7 world-state family (PROTOCOL.md §M7): the server-owned clock, per-region weather
// authority, server-issued custom records, operator cell resets, shared map exploration
// and server-pushed GUI. This module is the router + the two pieces that have nowhere
// better to live (records and the cell-reset scheduler); the clock, the weather
// authority and the GUI queue are their own modules.
//
// Everything inbound is validated and warn+dropped — a malformed frame costs the sender
// its message budget, never the shared world.

import type { LTable, LValue, JsLike } from '../proto/lser';
import { lToJs } from '../proto/lser';
import type { Player, Roster } from './players';
import { WorldClock } from './worldtime';
import { WeatherRegions } from './weather';
import { GuiRouter } from './gui';
import type { CellStore } from '../persist/cellstore';
import { RecordStore, RECORD_KINDS, type RecordKind, type CustomRecord } from '../persist/recordstore';
import { log } from '../log';

const MAX_CELL_KEY = 128;
const MAX_MAP_CELLS = 1024;
const MAX_RECORD_FIELDS = 128;
const RESET_TICK_MS = 1_000;

export const M7_EVENTS = new Set([
  'WorldTimeRequest',
  'WorldRegionChange',
  'WorldWeather',
  'RecordCreate',
  'WorldMapExplored',
  'GuiReply',
]);

export interface M7Ctx {
  roster: Roster;
  cells: CellStore;
  records: RecordStore;
  guiTimeoutMs: number;
  // M6 sharing policy, asked per relay (the `sharing` plugin answers from [sharing]).
  isMapShared(): boolean;
}

function str(v: LValue | undefined, max: number): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;
}

export class WorldM7 {
  readonly clock: WorldClock;
  readonly weather: WeatherRegions;
  readonly gui: GuiRouter;
  private recordQueue: Promise<void> = Promise.resolve();
  private resetTimer?: NodeJS.Timeout;

  constructor(private readonly ctx: M7Ctx) {
    const m7 = ctx.cells.worldM7();
    this.clock = new WorldClock({
      state: m7.time,
      save: () => ctx.cells.saveShared(),
      broadcast: (body) => this.broadcast('WorldTime', body),
    });
    this.weather = new WeatherRegions({
      roster: ctx.roster,
      weather: m7.weather,
      save: () => ctx.cells.saveShared(),
    });
    this.gui = new GuiRouter(ctx.roster, ctx.guiTimeoutMs);
  }

  start(): void {
    this.clock.start();
    if (!this.resetTimer) {
      this.resetTimer = setInterval(() => void this.sweepResets(), RESET_TICK_MS);
      this.resetTimer.unref();
    }
  }

  async stop(): Promise<void> {
    this.clock.stop();
    clearInterval(this.resetTimer);
    this.resetTimer = undefined;
    this.gui.closeAll();
    await this.drain();
  }

  drain(): Promise<void> {
    return this.recordQueue.then(() => this.weather.drain());
  }

  private broadcast(name: string, body: JsLike): void {
    for (const p of this.ctx.roster.inWorld()) p.peer.sendEvent(name, body);
  }

  // Router, mirroring Quests/WorldState: returns true when `name` belongs to M7.
  handleEvent(player: Player, name: string, value: LValue | undefined): boolean {
    if (!M7_EVENTS.has(name)) return false;
    const body = value instanceof Map ? value : undefined;
    if (!body) {
      log('warn', 'm7.invalid_body', { from: player.name, name });
      return true;
    }
    switch (name) {
      case 'WorldTimeRequest': this.clock.request(player.name, body); break;
      case 'WorldRegionChange': this.weather.changeRegion(player, body); break;
      case 'WorldWeather': this.weather.handleWeather(player, body); break;
      case 'RecordCreate': this.recordCreate(player, body); break;
      case 'WorldMapExplored': this.mapExplored(player, body); break;
      case 'GuiReply': this.gui.handleReply(player, body); break;
    }
    return true;
  }

  // Join: clock + every known region's weather + the full custom-record set, before the
  // player can be handed any object referencing a custom record.
  onJoinWorld(player: Player): void {
    this.clock.sendTo((name, body) => player.peer.sendEvent(name, body));
    this.weather.sendSyncTo(player);
    this.sendRecordsSync(player);
  }

  onDisconnect(playerId: number): void {
    this.weather.onDisconnect(playerId);
    this.gui.onDisconnect(playerId);
  }

  // ------------------------------------------------------------- records

  private sendRecordsSync(player: Player, records: CustomRecord[] = this.ctx.records.all()): void {
    player.peer.sendEvent('RecordsSync', {
      records: records.map((r) => ({ recordNetId: r.recordNetId, kind: r.kind, data: r.data })),
    });
  }

  // C->S RecordCreate {tempId, kind, data} -> RecordCreateAck {tempId, recordNetId}.
  // Serialized: acks must come back in the order the client sent them, and the store
  // mints ids and awaits durability inside the same turn.
  private recordCreate(player: Player, body: LTable): void {
    const tempId = body.get('tempId');
    const kind = body.get('kind');
    const data = body.get('data');
    if (
      typeof tempId !== 'number' || !Number.isFinite(tempId) ||
      typeof kind !== 'string' || !RECORD_KINDS.has(kind) ||
      !(data instanceof Map) || data.size > MAX_RECORD_FIELDS
    ) {
      log('warn', 'records.dropped', { from: player.name, why: 'invalid shape' });
      return;
    }
    const playerId = player.id;
    const accountKey = player.accountKey;
    const jsData = lToJs(data) as JsLike;
    this.recordQueue = this.recordQueue
      .then(async () => {
        const record = await this.ctx.records.create(kind as RecordKind, jsData, accountKey);
        log('info', 'records.created', { recordNetId: record.recordNetId, kind, by: accountKey });
        // Ack the creator first (per-connection FIFO maps tempId -> recordNetId before
        // anything referencing the record arrives), then push the single new record to
        // every OTHER in-world client as a one-entry RecordsSync — peers must be able to
        // resolve the id immediately, not only after their next join.
        this.ctx.roster.get(playerId)?.peer.sendEvent('RecordCreateAck', { tempId, recordNetId: record.recordNetId });
        for (const p of this.ctx.roster.inWorld()) {
          if (p.id !== playerId) this.sendRecordsSync(p, [record]);
        }
      })
      .catch((err) => log('error', 'records.create_failed', { error: String(err) }));
  }

  // ---------------------------------------------------------- cell resets

  // Operator/plugin schedule, persisted so it survives a restart. intervalSec = 0 means
  // "registered but manual only".
  scheduleCellReset(cellKey: string, intervalSec: number): boolean {
    if (!str(cellKey, MAX_CELL_KEY) || !Number.isFinite(intervalSec) || intervalSec < 0) return false;
    const resets = this.ctx.cells.worldM7().resets;
    const existing = resets[cellKey];
    resets[cellKey] = {
      cellKey,
      intervalSec,
      // Keep the elapsed clock on a reschedule: an operator editing the interval must not
      // silently postpone a reset that was already due.
      lastResetMs: existing?.lastResetMs ?? Date.now(),
    };
    this.ctx.cells.saveShared();
    return true;
  }

  unscheduleCellReset(cellKey: string): void {
    delete this.ctx.cells.worldM7().resets[cellKey];
    this.ctx.cells.saveShared();
  }

  scheduledResets(): string[] {
    return Object.keys(this.ctx.cells.worldM7().resets);
  }

  // Wipes the cell doc and tells every client to drop its local deltas and reload.
  async resetCellNow(cellKey: string): Promise<void> {
    if (!str(cellKey, MAX_CELL_KEY)) return;
    await this.ctx.cells.resetCell(cellKey);
    const entry = this.ctx.cells.worldM7().resets[cellKey];
    if (entry) {
      entry.lastResetMs = Date.now();
      this.ctx.cells.saveShared();
    }
    log('info', 'world.cell_reset', { cellKey });
    this.broadcast('WorldCellReset', { cellKey });
  }

  private async sweepResets(): Promise<void> {
    const now = Date.now();
    for (const entry of Object.values(this.ctx.cells.worldM7().resets)) {
      if (entry.intervalSec > 0 && now - entry.lastResetMs >= entry.intervalSec * 1000) {
        await this.resetCellNow(entry.cellKey);
      }
    }
  }

  // ------------------------------------------------------------ map share

  // C->S WorldMapExplored {cellKeys}; relayed to everyone else under [sharing] map.
  private mapExplored(player: Player, body: LTable): void {
    const raw = body.get('cellKeys');
    if (!(raw instanceof Map) || raw.size === 0 || raw.size > MAX_MAP_CELLS) {
      log('warn', 'map.dropped', { from: player.name, why: 'invalid shape' });
      return;
    }
    const cellKeys: string[] = [];
    for (const [, v] of raw) {
      const key = str(v, MAX_CELL_KEY);
      if (!key) {
        log('warn', 'map.dropped', { from: player.name, why: 'bad cellKey' });
        return;
      }
      cellKeys.push(key);
    }
    if (!this.ctx.isMapShared()) return; // individual mode: never relayed
    for (const p of this.ctx.roster.inWorld()) {
      if (p.id !== player.id) p.peer.sendEvent('WorldMapExplored', { cellKeys, byId: player.id });
    }
  }
}
