// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M6 quest layer (PROTOCOL.md §M6): shared journal, MWScript globals/locals, factions,
// crime, and the dialogue lock. Sharing is a POLICY decision and lives in the `sharing`
// plugin — this module asks the hook bus per family and only mechanises the arbitration:
//   journal  monotonic-max per questId (regression relayed only via regressAllowlist)
//   globals  last-write-wins with a per-variable seq (stale seq dropped); the M7 time
//            globals are excluded here entirely
//   locals   cell-scoped, stored in the cell doc
// Individual mode stores per-player and never relays.

import { lToJs, type LTable, type LValue, type JsLike } from '../proto/lser';
import { parseObjRef, type ObjRef } from '../proto/ref';
import type { Player, Roster } from './players';
import { cellsVisible } from './movement';
import type { CellStore } from '../persist/cellstore';
import type { PlayerStore } from '../persist/playerstore';
import { log } from '../log';

const MAX_ID = 64;
const MAX_CELL_KEY = 128;
const MAX_INDEX = 0x7fffffff;

// M7 owns the clock: these never travel as GlobalVarUpdate.
const TIME_GLOBALS = new Set(['gamehour', 'day', 'month', 'year', 'dayspassed']);

export type ShareFamily = 'journal' | 'questVars' | 'factions' | 'crime' | 'map';

export const QUEST_EVENTS = new Set([
  'JournalEntry',
  'GlobalVarUpdate',
  'MemberVarUpdate',
  'FactionUpdate',
  'CrimeUpdate',
  'DialogueLock',
]);

export interface QuestCtx {
  roster: Roster;
  cells: CellStore;
  players: PlayerStore;
  // Plugin-owned policy: may this family be relayed/shared at all?
  isShared(family: ShareFamily): boolean;
  // Quest ids permitted to regress (operator config, surfaced via the plugin).
  regressAllowed(questId: string): boolean;
}

function tbl(v: LValue | undefined): LTable | undefined {
  return v instanceof Map ? v : undefined;
}

function str(v: LValue | undefined, max = MAX_ID): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;
}

function finite(v: LValue | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function index(v: LValue | undefined): number | undefined {
  const n = finite(v);
  return n !== undefined && Number.isInteger(n) && n >= 0 && n <= MAX_INDEX ? n : undefined;
}

export class Quests {
  // refKey -> the player currently holding the conversation, plus where it started.
  private dialogueLocks = new Map<string, { playerId: number; cellKey: string }>();

  constructor(private readonly ctx: QuestCtx) {}

  private drop(player: Player, name: string, why: string): void {
    log('warn', 'quest.dropped', { from: player.name, name, why });
  }

  // Relays exclude the sender: it already applied the change locally, and clients seed
  // their diff caches from applied state (the §M6 echo guard).
  private relayAll(exceptId: number, name: string, body: JsLike): void {
    for (const p of this.ctx.roster.inWorld()) if (p.id !== exceptId) p.peer.sendEvent(name, body);
  }

  private relayCell(cellKey: string, exceptId: number, name: string, body: JsLike): void {
    for (const p of this.ctx.roster.inWorld()) {
      if (p.id !== exceptId && cellsVisible(p.cellKey, cellKey)) p.peer.sendEvent(name, body);
    }
  }

  handleEvent(player: Player, name: string, value: LValue | undefined): boolean {
    if (!QUEST_EVENTS.has(name)) return false;
    const body = tbl(value);
    if (!body) {
      this.drop(player, name, 'malformed body');
      return true;
    }
    switch (name) {
      case 'JournalEntry': this.journal(player, body); break;
      case 'GlobalVarUpdate': this.globalVar(player, body); break;
      case 'MemberVarUpdate': this.memberVar(player, body); break;
      case 'FactionUpdate': this.faction(player, body); break;
      case 'CrimeUpdate': this.crime(player, body); break;
      case 'DialogueLock': this.dialogueLock(player, body); break;
    }
    return true;
  }

  // ---------------------------------------------------------------- journal

  private journal(player: Player, body: LTable): void {
    const questId = str(body.get('questId'));
    const idx = index(body.get('index'));
    const actorRefId = body.get('actorRefId');
    if (!questId || idx === undefined || (actorRefId !== undefined && !str(actorRefId))) {
      this.drop(player, 'JournalEntry', 'invalid shape');
      return;
    }
    // The player's own journal records what THEY reported, even when the shared map
    // refuses it — §M6: non-monotonic updates are stored but not relayed.
    this.ctx.players.update(player.charId, (doc) => {
      (doc.journal ??= {})[questId] = idx;
    });
    if (!this.ctx.isShared('journal')) return; // individual mode: stored, never relayed

    const shared = this.ctx.cells.sharedQuest();
    const current = shared.journal[questId];
    const advances = current === undefined || idx > current;
    const regressing = !advances && idx < current;
    if (regressing && !this.ctx.regressAllowed(questId)) {
      // Monotonic-max arbitration: a lagging client cannot rewind a shared quest.
      log('debug', 'quest.journal_regress_blocked', { questId, have: current, got: idx, from: player.name });
      return;
    }
    if (!advances && !regressing) return; // identical index: nothing to do
    shared.journal[questId] = idx;
    this.ctx.cells.saveShared();
    const out: JsLike = { questId, index: idx, ...(typeof actorRefId === 'string' ? { actorRefId } : {}) };
    this.relayAll(player.id, 'JournalEntry', out);
  }

  // Full journal state for a joining client: the shared map, or their own in individual
  // mode. Always sent (an empty map is a valid, meaningful answer).
  sendJournalSync(player: Player): void {
    const quests = this.ctx.isShared('journal')
      ? { ...this.ctx.cells.sharedQuest().journal }
      : { ...(this.ctx.players.getCached(player.charId)?.journal ?? {}) };
    player.peer.sendEvent('JournalSync', { quests });
  }

  // ---------------------------------------------------------------- globals

  private globalVar(player: Player, body: LTable): void {
    const name = str(body.get('name'));
    const value = finite(body.get('value'));
    const rawSeq = body.get('seq');
    const seq = rawSeq === undefined ? undefined : finite(rawSeq);
    if (!name || value === undefined || (rawSeq !== undefined && seq === undefined)) {
      this.drop(player, 'GlobalVarUpdate', 'invalid shape');
      return;
    }
    if (TIME_GLOBALS.has(name.toLowerCase())) {
      // M7 owns the clock; accepting these here would fight WorldTime.
      log('debug', 'quest.time_global_dropped', { name, from: player.name });
      return;
    }
    if (!this.ctx.isShared('questVars')) return; // individual mode: globals are local-only

    const shared = this.ctx.cells.sharedQuest();
    const prev = shared.globals[name];
    if (seq !== undefined && prev !== undefined && seq <= prev.seq) {
      log('debug', 'quest.global_stale_seq', { name, have: prev.seq, got: seq, from: player.name });
      return;
    }
    // Absent seq = plain last-write-wins; keep the stored seq monotonic regardless.
    const nextSeq = seq ?? (prev ? prev.seq + 1 : 1);
    shared.globals[name] = { value, seq: nextSeq };
    this.ctx.cells.saveShared();
    this.relayAll(player.id, 'GlobalVarUpdate', { name, value, seq: nextSeq });
  }

  // Per-object MWScript locals. The body carries no cellKey (it piggybacks on object
  // interaction), so the cell is inferred from the sender's current cell.
  private memberVar(player: Player, body: LTable): void {
    const ref = parseObjRef(body);
    const name = str(body.get('name'));
    const value = finite(body.get('value'));
    const cellKey = player.cellKey;
    if (!ref || ref.kind !== 'ref' || !name || value === undefined || !cellKey) {
      this.drop(player, 'MemberVarUpdate', 'invalid shape or no cell');
      return;
    }
    void this.storeMemberVar(cellKey, ref, name, value);
    this.relayCell(cellKey, player.id, 'MemberVarUpdate', { ...(lToJs(body) as Record<string, JsLike>) });
  }

  private async storeMemberVar(cellKey: string, ref: ObjRef, name: string, value: number): Promise<void> {
    const doc = await this.ctx.cells.get(cellKey);
    const vars = (doc.memberVars ??= {});
    (vars[ref.key] ??= {})[name] = value;
    this.ctx.cells.markDirty(cellKey);
  }

  // --------------------------------------------------------- factions/crime

  private faction(player: Player, body: LTable): void {
    const factionId = str(body.get('factionId'));
    const rank = finite(body.get('rank'));
    const reputation = body.get('reputation') === undefined ? undefined : finite(body.get('reputation'));
    const expelledRaw = body.get('expelled');
    const expelled = expelledRaw === undefined ? undefined : expelledRaw === true;
    if (
      !factionId || rank === undefined || !Number.isInteger(rank) || rank < -1 || rank > 20 ||
      (body.get('reputation') !== undefined && reputation === undefined) ||
      (expelledRaw !== undefined && typeof expelledRaw !== 'boolean')
    ) {
      this.drop(player, 'FactionUpdate', 'invalid shape');
      return;
    }
    const state = { rank, ...(reputation !== undefined ? { reputation } : {}), ...(expelled !== undefined ? { expelled } : {}) };
    this.ctx.players.update(player.charId, (doc) => {
      (doc.factions ??= {})[factionId] = state;
    });
    if (!this.ctx.isShared('factions')) return;
    const shared = this.ctx.cells.sharedQuest();
    shared.factions[factionId] = state;
    this.ctx.cells.saveShared();
    this.relayAll(player.id, 'FactionUpdate', { factionId, ...state });
  }

  private crime(player: Player, body: LTable): void {
    const bounty = finite(body.get('bounty'));
    const kind = body.get('kind');
    if (bounty === undefined || bounty < 0 || (kind !== undefined && !str(kind))) {
      this.drop(player, 'CrimeUpdate', 'invalid shape');
      return;
    }
    this.ctx.players.update(player.charId, (doc) => (doc.bounty = bounty));
    if (!this.ctx.isShared('crime')) return; // personal bounty
    const shared = this.ctx.cells.sharedQuest();
    shared.bounty = bounty;
    this.ctx.cells.saveShared();
    this.relayAll(player.id, 'CrimeUpdate', {
      bounty,
      ...(typeof kind === 'string' ? { kind } : {}),
      byId: player.id,
    });
  }

  // --------------------------------------------------------- dialogue locks

  // One player may converse with a given NPC at a time; the loser learns who holds it.
  private dialogueLock(player: Player, body: LTable): void {
    const ref = parseObjRef(body);
    const cellKey = str(body.get('cellKey'), MAX_CELL_KEY);
    const want = body.get('want');
    if (!ref || ref.kind !== 'ref' || !cellKey || typeof want !== 'boolean') {
      this.drop(player, 'DialogueLock', 'invalid shape');
      return;
    }
    const held = this.dialogueLocks.get(ref.key);
    if (!want) {
      if (held?.playerId === player.id) this.dialogueLocks.delete(ref.key);
      player.peer.sendEvent('DialogueLockResult', { ref: refBody(ref), granted: false });
      return;
    }
    if (held && held.playerId !== player.id && this.ctx.roster.get(held.playerId)?.inWorld) {
      player.peer.sendEvent('DialogueLockResult', { ref: refBody(ref), granted: false, holderId: held.playerId });
      return;
    }
    this.dialogueLocks.set(ref.key, { playerId: player.id, cellKey });
    player.peer.sendEvent('DialogueLockResult', { ref: refBody(ref), granted: true });
  }

  // Release every lock held by a player (disconnect), or only those bound to a cell they
  // just left (cell change) — walking away ends the conversation.
  releaseDialogueLocks(playerId: number, onlyCellKey?: string): void {
    for (const [key, held] of [...this.dialogueLocks]) {
      if (held.playerId !== playerId) continue;
      if (onlyCellKey !== undefined && held.cellKey !== onlyCellKey) continue;
      this.dialogueLocks.delete(key);
    }
  }

  dialogueHolder(refKey: string): number | undefined {
    return this.dialogueLocks.get(refKey)?.playerId;
  }
}

function refBody(ref: ObjRef): JsLike {
  return ref.kind === 'ref' ? { __refnum: { index: ref.index, contentFile: ref.contentFile } } : ref.netId;
}
