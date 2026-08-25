// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 4 party rules: difficulty scaling, loot sharing, and the roll.
//
// All three key on CO-PRESENCE (same cell visibility), not on membership alone — a member
// shopping in Balmora should not buff the dungeon you are in, nor take a cut of what you
// find there. Same check the quest-credit rule uses, for the same reason.
//
// XP IS DELIBERATELY ABSENT. Morrowind progression is use-based: your Long Blade rises
// because YOU swung it. There is no experience pool to divide, so the entire genre problem
// of kill-stealing and leech-leveling does not exist here, and the only thing to get right
// is not to invent it. A level-5 and a level-30 friend can hunt together and each advances
// exactly by what they personally do.

import type { Player, Roster } from './players';
import { cellsVisible } from './movement';
import { log } from '../log';

export interface PartyScaling {
  // Sub-linear on purpose. A party's real advantage is ACTION ECONOMY — four bodies, four
  // sets of paralyze/summons, and an enemy can only swing at one of you — so raw HP
  // multipliers alone make fights tedious rather than dangerous. Valheim under-scales
  // (co-op trivial); V Rising multiplies boss minions per player and its top complaint is
  // that fights are harsher with friends than solo. Both failures are worth avoiding.
  hpPerExtra: number; // +35% HP per co-present member beyond the first
  damagePerExtra: number; // +15% damage
  spawnPerExtraMembers: number; // one extra leveled creature per N extra members
  maxExtraSpawns: number;
}

export const DEFAULT_SCALING: PartyScaling = {
  hpPerExtra: 0.35,
  damagePerExtra: 0.15,
  spawnPerExtraMembers: 2,
  maxExtraSpawns: 3,
};

export interface PartyRulesCtx {
  roster: Roster;
  partyOf(accountKey: string): string[];
  // Leader-toggled settings, per party. Defaults live here so a party that never opens
  // the panel still behaves sensibly.
  settingsOf(accountKey: string): { goldSplit: boolean; rollOnRare: boolean; scaling: boolean };
  isNotable(recordId: string): boolean;
  scaling?: PartyScaling;
  enabled: boolean;
}

export interface RollState {
  itemId: string;
  cellKey: string;
  // acct -> 'need' | 'pass'; absent = not answered yet
  votes: Map<string, 'need' | 'pass'>;
  members: string[];
  expiresAt: number;
}

const ROLL_TIMEOUT_MS = 20_000;

export class PartyRules {
  private rolls = new Map<string, RollState>(); // rollId -> state
  private nextRoll = 1;

  constructor(private readonly ctx: PartyRulesCtx) {}

  // The party members standing where this player is. The list ALWAYS includes the player
  // themselves when they are in a party, so callers can use its length directly.
  coPresent(player: Player): Player[] {
    if (!this.ctx.enabled) return [];
    const members = this.ctx.partyOf(player.accountKey);
    if (members.length === 0) return [];
    return this.ctx.roster.inWorld().filter(
      (p) => !p.system && members.includes(p.accountKey) && cellsVisible(p.cellKey, player.cellKey),
    );
  }

  // Multipliers the cell's authority client applies when a fight starts. Snapshotted at
  // combat start by the client and NOT re-evaluated mid-fight: a member walking in should
  // not visibly inflate an enemy's health bar (that reads as jank), and one dying should
  // not deflate it (that would reward sacrificing the weakest member).
  scalingFor(player: Player): { hp: number; damage: number; extraSpawns: number; members: number } | null {
    // THE LEADER'S CHOICE, not the operator's. `enabled` is the operator's kill switch; within a
    // world that allows it, whether a given party plays scaled is that party's decision — which
    // is the whole point of shipping the default OFF rather than removing the feature.
    if (!this.ctx.settingsOf(player.accountKey).scaling) return null;
    const present = this.coPresent(player);
    const extra = Math.max(0, present.length - 1);
    if (extra === 0) return null;
    const s = this.ctx.scaling ?? DEFAULT_SCALING;
    return {
      hp: 1 + s.hpPerExtra * extra,
      damage: 1 + s.damagePerExtra * extra,
      // Spawn augmentation counters the action economy that HP cannot. Capped hard, and
      // the client must never apply it to a NAMED or scripted encounter — multiplying a
      // scripted fight's actors is exactly the V Rising mistake, and it would also collide
      // with quest-spawn replay.
      extraSpawns: Math.min(s.maxExtraSpawns, Math.floor(extra / s.spawnPerExtraMembers)),
      members: present.length,
    };
  }

  // Gold is the one drop where first-grab breeds resentment, so it splits evenly among
  // co-present members; the remainder goes to the looter rather than vanishing.
  // Everything else stays free-for-all, which is what every successful co-op peer ships
  // and what friends actually expect.
  splitGold(player: Player, amount: number): { acct: string; share: number }[] | null {
    if (!this.ctx.settingsOf(player.accountKey).goldSplit) return null;
    const present = this.coPresent(player);
    if (present.length <= 1 || amount <= 0) return null;
    const share = Math.floor(amount / present.length);
    if (share === 0) return null; // a 3-gold split among 4 is not worth the message
    const remainder = amount - share * present.length;
    return present.map((p) => ({
      acct: p.accountKey,
      share: p.accountKey === player.accountKey ? share + remainder : share,
    }));
  }

  // A notable item (artifact/enchanted tier) may be rolled for instead of taken. Off by
  // default: most groups do not want the interruption, and the ones that do can say so.
  shouldRoll(player: Player, itemId: string): boolean {
    if (!this.ctx.settingsOf(player.accountKey).rollOnRare) return false;
    if (!this.ctx.isNotable(itemId)) return false;
    return this.coPresent(player).length > 1;
  }

  startRoll(player: Player, itemId: string, now = Date.now()): { rollId: string; members: Player[] } {
    const members = this.coPresent(player);
    const rollId = `r${this.nextRoll++}`;
    this.rolls.set(rollId, {
      itemId,
      cellKey: player.cellKey ?? '',
      votes: new Map(),
      members: members.map((m) => m.accountKey),
      expiresAt: now + ROLL_TIMEOUT_MS,
    });
    for (const m of members) {
      m.peer.sendEvent('LootRoll', { rollId, itemId, from: player.name });
    }
    log('info', 'party.roll_started', { rollId, itemId, members: members.length });
    return { rollId, members };
  }

  // Returns the winner once everyone has answered or the window lapses. 'need' beats
  // 'pass'; among needs the winner is chosen by the highest roll, decided here rather than
  // client-side for the obvious reason.
  vote(rollId: string, accountKey: string, choice: 'need' | 'pass', now = Date.now()):
  { done: false } | { done: true; winner?: string; itemId: string } {
    const roll = this.rolls.get(rollId);
    if (!roll) return { done: false };
    if (!roll.members.includes(accountKey)) return { done: false };
    roll.votes.set(accountKey, choice);
    const everyone = roll.members.every((m) => roll.votes.has(m));
    if (!everyone && now < roll.expiresAt) return { done: false };
    return this.settle(rollId, now);
  }

  // Anyone who never answered is treated as a pass: a group must not be stuck because
  // somebody walked away from the keyboard.
  settle(rollId: string, _now = Date.now()): { done: true; winner?: string; itemId: string } {
    const roll = this.rolls.get(rollId)!;
    this.rolls.delete(rollId);
    const needs = roll.members.filter((m) => roll.votes.get(m) === 'need');
    let winner: string | undefined;
    if (needs.length > 0) {
      let best = -1;
      for (const acct of needs) {
        const r = Math.floor(Math.random() * 100) + 1;
        if (r > best) {
          best = r;
          winner = acct;
        }
      }
    }
    log('info', 'party.roll_settled', { rollId, itemId: roll.itemId, winner: winner ?? 'nobody' });
    return { done: true, ...(winner ? { winner } : {}), itemId: roll.itemId };
  }

  // Rolls whose window lapsed while nobody answered. Called on a timer so a forgotten roll
  // cannot pin an item forever.
  sweep(now = Date.now()): { rollId: string; winner?: string; itemId: string }[] {
    const out: { rollId: string; winner?: string; itemId: string }[] = [];
    for (const [rollId, roll] of [...this.rolls]) {
      if (now >= roll.expiresAt) {
        const r = this.settle(rollId, now);
        out.push({ rollId, ...(r.winner ? { winner: r.winner } : {}), itemId: r.itemId });
      }
    }
    return out;
  }
}
