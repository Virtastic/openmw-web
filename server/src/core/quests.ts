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

// Phase 4: mwscript globals split into WORLD-SHARED and CHARACTER-SHADOWED.
//
// Morrowind gates most quests on globals, not on the journal index. With per-character
// journals, relaying every global world-wide makes two party members at different stages
// fight over the same variable through the 1 s diff sync — each client re-asserting its
// own value, forever. So the default is INVERTED from M6: a global is character-shadowed
// (stored on the character, never relayed) unless it describes the WORLD rather than a
// character's progress.
//
// The world-shared set is deliberately small and conservative, because the failure modes
// are asymmetric: wrongly sharing a progress global causes the ping-pong above and can
// skip a player's quest; wrongly shadowing a world global only means it does not
// propagate, which reads as vanilla single-player behaviour. Operators extend it via
// [sharing].worldGlobals for total conversions that keep world state in globals.
const WORLD_GLOBALS = new Set([
  // Weather/environment the whole realm observes.
  'weather', 'nextweather', 'weatherregion', 'currentweather',
  // Blight/ash storm and the Ghostfence — realm-visible world state in vanilla.
  'blightdisease', 'ghostfence', 'gamehourlast',
  // Vampire clock and the werewolf state are per-character despite the naming; NOT here.
]);

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
  // Phase 4 party credit: the accountKeys of this player's party (empty when solo). Read
  // through a function because Social is built after Quests and party membership changes
  // constantly — a snapshot would go stale between events.
  partyOf(accountKey: string): string[];
  // Operator additions to the world-shared global set (total conversions).
  worldGlobals?: string[];
  // Party credit on/off (per-realm rule).
  partyCredit?: boolean;
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
    // Phase 4: party credit. Co-present party members who ALREADY STARTED this quest and
    // are BEHIND this stage advance with it — they were there for the deed. Members who
    // never started it get nothing (no spoiler-jumping them forward, the TES3MP shared-
    // journal disease) and members already ahead get nothing (no rewind).
    this.creditParty(player, questId, idx);
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

  // Phase 4 party credit. Eligibility is deliberately narrow and checked per member:
  //   * in the crediting player's party (membership, not proximity alone), and
  //   * CO-PRESENT (cellsVisible) — you get credit for deeds you were there for, and
  //   * has an existing journal entry for this quest (they started it themselves), and
  //   * strictly behind the new index (never rewind, never leap someone who is ahead).
  // The mirror of the TES3MP failure the community names most: nobody's log ever moves
  // through content they did not participate in.
  private creditParty(player: Player, questId: string, idx: number): void {
    if (this.ctx.partyCredit === false) return;
    const party = this.ctx.partyOf(player.accountKey);
    if (party.length === 0) return;
    for (const p of this.ctx.roster.inWorld()) {
      if (p.id === player.id || p.system) continue;
      if (!party.includes(p.accountKey)) continue;
      if (!cellsVisible(p.cellKey, player.cellKey)) continue;
      const theirs = this.ctx.players.getCached(p.charId)?.journal?.[questId];
      if (theirs === undefined || theirs >= idx) continue; // not started, or already ahead
      this.ctx.players.update(p.charId, (doc) => {
        (doc.journal ??= {})[questId] = idx;
      }, 'now'); // a credited stage must survive a disconnect the instant it is earned
      p.peer.sendEvent('JournalEntry', { questId, index: idx, credited: true });
      log('info', 'quest.party_credit', { questId, index: idx, to: p.name, from: player.name });
    }
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
    const lower = name.toLowerCase();
    if (TIME_GLOBALS.has(lower)) {
      // M7 owns the clock; accepting these here would fight WorldTime.
      log('debug', 'quest.time_global_dropped', { name, from: player.name });
      return;
    }
    // Phase 4: character-shadowed globals are the DEFAULT, and shadowing is PERSISTENCE,
    // not relaying — so it happens whatever the questVars sharing policy says. Store on
    // the character (a rejoin or world hop restores the player's own quest state) and
    // relay to nobody: relaying is what makes two party members at different stages
    // overwrite each other forever.
    if (!this.isWorldGlobal(lower)) {
      this.ctx.players.update(player.charId, (doc) => {
        (doc.globals ??= {})[name] = value;
      });
      return;
    }
    if (!this.ctx.isShared('questVars')) return; // world global, but sharing is off

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

  private isWorldGlobal(lowerName: string): boolean {
    if (WORLD_GLOBALS.has(lowerName)) return true;
    return (this.ctx.worldGlobals ?? []).some((g) => g.toLowerCase() === lowerName);
  }

  // A joining client gets its character's shadowed globals back, so quest state that never
  // travels world-wide still survives a relog or a world hop.
  sendGlobalSync(player: Player): void {
    const globals = { ...(this.ctx.players.getCached(player.charId)?.globals ?? {}) };
    if (Object.keys(globals).length === 0) return;
    player.peer.sendEvent('GlobalVarSync', { globals });
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
