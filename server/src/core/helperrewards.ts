// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-91: helping must pay. When a partied player reaches a quest stage and a co-present
// partner gets nothing from the party quest credit (not on that quest at all: another
// faction's; or already past the stage), that partner is a HELPER and is paid gold from the
// server instead. A higher-level mentor helping a sprout gets a small bonus on top. Every
// payout is a row in the item ledger (trades.db) so "who was paid what" is answerable, and a
// per-character daily cap keeps two alts from farming it.
// Skill gain while partied (Morrowind has no kill XP) is the client's: social.lua scales the
// engine's skill-gain by PARTY_SKILL_GAIN while in a party of two or more.
// ponytail: flat amounts, not scaled by quest value; tune HELPER_GOLD once there is data.

import type { Player } from './players';
import type { LedgerEntry } from './trade';
import { GOLD_ID } from './economy';
import { MENTOR_MIN_LEVEL, NOVICE_MAX_LEVEL } from './chat';
import { log } from '../log';

export const HELPER_GOLD = 40;
export const MENTOR_BONUS_GOLD = 20;
export const HELPER_DAILY_CAP = 600;
export const PARTY_SKILL_GAIN = 1.15; // mirrored in social.lua
const DAY_MS = 24 * 60 * 60_000;

export interface HelperDeps {
  now(): number;
  levelOf(p: Player): number;
  /** false for a staff-revoked mentor. */
  mentorOk(p: Player): boolean;
  /** Put gold on the helper (AdminGive-style client add) with a line the player reads. */
  give(p: Player, gold: number, note: string): void;
  ledger(e: LedgerEntry): void;
}

export class HelperRewards {
  private readonly paid = new Set<string>();
  private readonly daily = new Map<string, { since: number; gold: number }>();
  private seq = 0;

  constructor(private readonly d: HelperDeps) {}

  /** Returns the gold paid (0 = nothing: repeat, capped). */
  reward(writer: Player, helper: Player, questId: string, idx: number): number {
    const key = `${writer.charId}>${helper.charId}:${questId}:${idx}`;
    if (this.paid.has(key)) return 0;
    const now = this.d.now();
    let gold = HELPER_GOLD;
    const mentor = this.d.levelOf(helper) >= MENTOR_MIN_LEVEL && this.d.levelOf(writer) < NOVICE_MAX_LEVEL
      && this.d.mentorOk(helper);
    if (mentor) gold += MENTOR_BONUS_GOLD;
    let day = this.daily.get(helper.charId);
    if (!day || now - day.since >= DAY_MS) { day = { since: now, gold: 0 }; this.daily.set(helper.charId, day); }
    if (day.gold + gold > HELPER_DAILY_CAP) return 0;
    day.gold += gold;
    // ponytail: one entry per helped stage ever; prune when it passes 20k (a restart also clears it).
    if (this.paid.size > 20_000) this.paid.clear();
    this.paid.add(key);
    this.d.ledger({
      id: 0, ts: now, reason: `helper reward: ${questId}@${idx}${mentor ? ' +mentor' : ''}`,
      a: { char: 'server:helper', name: 'helper reward', gave: [{ id: GOLD_ID, n: gold }] },
      b: { char: helper.charId, name: helper.name, gave: [] },
    });
    this.d.give(helper, gold, `${writer.name}'s party reached a stage you helped with: ${gold} gold`
      + (mentor ? ' (mentor bonus included)' : '') + '.');
    this.seq++;
    log('info', 'party.helper_reward', { helper: helper.name, writer: writer.name, questId, index: idx, gold, mentor });
    return gold;
  }

  /** Test seam. */
  count(): number { return this.seq; }
}
