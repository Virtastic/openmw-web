// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 4: scripted-spawn replay, the quest whitelist, and the unstick tool.
//
// THREE PROBLEMS THAT ARE REALLY ONE. Morrowind quests were written for exactly one
// player, so anything a quest does ONCE is wrong the moment a second person needs it:
//
//   * a scripted spawn (Azura's Staada, Tribunal's Fabricants) fires once and the player
//     who was not there — or who joined late — never sees it
//   * a stage advances on the server for one character and the other's journal is
//     untouched, which is correct per-character behaviour but leaves them looking at a
//     world where the deed is already done
//   * and when either of the above lands wrong, the player is STUCK with no recourse
//
// Skyrim Together shipped an F3 quest debugger because stuck quests are inevitable, not
// because they were careless. Planning for repair is the honest position; pretending a
// quest system covering 300+ vanilla quests will be perfect is not.

import type { Player, Roster } from './players';
import type { PlayerStore } from '../persist/playerstore';
import { log } from '../log';

// A scripted spawn worth replaying: when a character's journal for `questId` sits in
// [minIndex, maxIndex] and they enter `cellKey`, the actor should be there for them.
export interface SpawnRule {
  questId: string;
  minIndex: number;
  maxIndex: number;
  cellKey: string;
  recordId: string; // the actor to spawn
  // Respawn cooldown per character, so re-entering a cell does not stack copies.
  cooldownSec: number;
}

// The vanilla cases the community's own TES3MP fix scripts had to special-case. Shipped as
// defaults so a fresh install behaves correctly; an operator's quests.json replaces them.
export const DEFAULT_SPAWN_RULES: SpawnRule[] = [
  {
    // Azura's quest: Staada spawns once when the shrine is used. A second player standing
    // in an empty shrine with an active quest entry is the canonical report.
    questId: 'da_azura', minIndex: 1, maxIndex: 49,
    cellKey: 'azura\'s coast region', recordId: 'staada', cooldownSec: 900,
  },
];

// Quests verified to work under the party model. Everything else still PLAYS — it just
// behaves like TES3MP does today (best-effort shared world) rather than claiming the
// per-character guarantees. An allowlist is honest; a blanket claim across 300+ quests
// would not survive contact with the first Tribunal playthrough.
export const DEFAULT_QUEST_WHITELIST = [
  'a1_1_findspymaster', 'a1_2_antabolisinformant', 'a1_4_muzgobinformant',
  'a2_2_6thhouse', 'a2_3_expelledblades', 'a2_4_miloinformant',
  'ms_corprus', 'ms_zainab_bride', 'ms_dwemerpuzzlebox',
  'da_azura', 'da_mehrunes', 'da_molagbal',
];

export interface QuestRepairCtx {
  roster: Roster;
  players: PlayerStore;
  spawnRules?: SpawnRule[];
  whitelist?: string[];
}

export class QuestRepair {
  // charId -> `${questId}:${recordId}` -> last spawn time (ms). Per CHARACTER, because
  // the whole point is that each player gets their own copy of a one-shot event.
  private lastSpawn = new Map<string, Map<string, number>>();
  private readonly rules: SpawnRule[];
  private readonly whitelist: Set<string>;

  constructor(private readonly ctx: QuestRepairCtx) {
    this.rules = ctx.spawnRules ?? DEFAULT_SPAWN_RULES;
    this.whitelist = new Set((ctx.whitelist ?? DEFAULT_QUEST_WHITELIST).map((q) => q.toLowerCase()));
  }

  isWhitelisted(questId: string): boolean {
    return this.whitelist.has(questId.toLowerCase());
  }

  // Called when a player enters a cell. Returns the spawns this character is owed —
  // one-shot events replayed for someone who was not there when they first fired.
  onCellEntry(player: Player, cellKey: string, now = Date.now()): { recordId: string; questId: string }[] {
    const journal = this.ctx.players.getCached(player.charId)?.journal ?? {};
    const owed: { recordId: string; questId: string }[] = [];
    const seen = this.lastSpawn.get(player.charId) ?? new Map<string, number>();

    for (const rule of this.rules) {
      if (rule.cellKey.toLowerCase() !== cellKey.toLowerCase()) continue;
      const idx = journal[rule.questId];
      // Eligibility is the character's OWN stage: someone who has not started the quest
      // gets nothing (no spoiling an encounter they have no context for), and someone
      // past it gets nothing either.
      if (idx === undefined || idx < rule.minIndex || idx > rule.maxIndex) continue;
      const key = `${rule.questId}:${rule.recordId}`;
      // `undefined` means NEVER spawned for this character and must always be eligible.
      // Defaulting to 0 conflated that with "spawned at the epoch", which only ever looked
      // correct because real timestamps are huge — under any injected clock the very first
      // spawn was silently suppressed.
      const last = seen.get(key);
      if (last !== undefined && now - last < rule.cooldownSec * 1000) continue;
      seen.set(key, now);
      owed.push({ recordId: rule.recordId, questId: rule.questId });
    }
    if (owed.length > 0) {
      this.lastSpawn.set(player.charId, seen);
      log('info', 'quest.spawn_replay', {
        character: player.charId, cellKey, spawns: owed.map((o) => o.recordId).join(','),
      });
    }
    return owed;
  }

  // ------------------------------------------------------------------ repair

  // What the player (or a moderator) can see about a character's quest state. Read-only,
  // and the first thing anyone needs when a quest is stuck.
  inspect(charId: string): { journal: Record<string, number>; globals: Record<string, number> } {
    const doc = this.ctx.players.getCached(charId);
    return { journal: { ...(doc?.journal ?? {}) }, globals: { ...(doc?.globals ?? {}) } };
  }

  // Force a stage. Deliberately allows going BACKWARDS: the common stuck case is a stage
  // that advanced past a step the player never completed, and refusing to rewind would
  // make the tool useless exactly when it is needed. Every use is logged with who did it.
  setStage(charId: string, questId: string, index: number, by: string): boolean {
    if (!Number.isInteger(index) || index < 0 || index > 0x7fffffff) return false;
    this.ctx.players.update(charId, (doc) => {
      (doc.journal ??= {})[questId] = index;
    }, 'now');
    log('warn', 'quest.stage_forced', { character: charId, questId, index, by });
    return true;
  }

  // Clear a character's spawn cooldowns so an owed encounter can be re-triggered on the
  // next entry — the other half of "my quest NPC never appeared".
  clearSpawnCooldowns(charId: string, by: string): void {
    this.lastSpawn.delete(charId);
    log('warn', 'quest.spawn_cooldowns_cleared', { character: charId, by });
  }
}
