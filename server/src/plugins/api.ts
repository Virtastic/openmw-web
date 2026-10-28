// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Plugin surface: lifecycle + gameplay hooks and a small action API. Built-ins only in
// M0; the shapes are the contract later external plugins will get.

import type { Config } from '../config';
import type { LogLevel } from '../log';
import type { ChatMessageBody } from '../core/chat';
import type { JsLike } from '../proto/lser';
import type { ShareFamily } from '../core/quests';

// M7 world actions: the operator-facing clock and cell-reset controls.
interface PluginWorld {
  time(): { gameHour: number; day: number; month: number; year: number; timeScale: number };
  advanceTime(hours: number): void;
  setTimeScale(scale: number): void;
  scheduleCellReset(cellKey: string, intervalSec: number): boolean;
  unscheduleCellReset(cellKey: string): void;
  scheduledResets(): string[];
  resetCell(cellKey: string): Promise<void>;
  // M8: promote an existing account to owner (rank 3). Resolves false if unknown.
  promoteOwner(account: string): Promise<boolean>;
}

export interface PluginPlayer {
  id: number;
  name: string;
  rank: number;
}

export interface PluginApi {
  config: Config;
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
  players(): PluginPlayer[];
  // target: 'all' broadcasts to everyone in-world; a playerId sends to that player.
  chat(target: 'all' | number, msg: ChatMessageBody): void;
  // Raw event-tier send (M2; e.g. PlayerResurrect from the respawn plugin).
  sendEvent(target: 'all' | number, name: string, body: JsLike): void;
  world: PluginWorld; // M7
  // Phase 3 rule helpers. Optional so an embedder can supply a partial api in tests
  // without every plugin needing to care.
  cellOfPlayer?(playerId: number): string | undefined;
  /** The character's level (1 until their stats are known). OT3-162 sprout protection. */
  levelOfPlayer?(playerId: number): number;
  /** Where a player currently is, or undefined if they have not reported a pose yet. Needed by
   *  any rule that has to put somebody NEXT TO somebody else — summons, travel. */
  posOfPlayer?(playerId: number): { cellKey: string; x: number; y: number; z: number } | undefined;
  /** OT3-163: why these two may fight (an accepted duel, both flagged, both in the Arena), or undefined. */
  pvpConsent?(attackerId: number, victimId: number): 'duel' | 'flag' | 'arena' | undefined;
  /** OT3-163: this death was a consented fight (ends the duel). Idempotent. */
  diedInDuel?(playerId: number): boolean;
  /** OT3-174: ids of this player's party members in the world, themselves excluded. */
  partyOnline?(playerId: number): number[];
  /** OT3-174: the temples/shrines this character has visited, and the last outdoor spot they left. */
  shrinesOf?(playerId: number): { shrines: { cellKey: string; x: number; y: number; z: number; ex?: number; ey?: number }[]; outside?: { x: number; y: number } };
  /** OT3-174: the character's base health, when their stats are known. */
  maxHealthOf?(playerId: number): number | undefined;
}

export interface Plugin {
  name: string;
  onServerStart?(api: PluginApi): void;
  onServerStop?(api: PluginApi): void;
  onPlayerAuthed?(api: PluginApi, player: PluginPlayer): void;
  onPlayerJoinWorld?(api: PluginApi, player: PluginPlayer): void;
  onPlayerDisconnect?(api: PluginApi, player: PluginPlayer): void;
  // M2: fired when a PlayerDeath event arrives (respawn/death-penalty seeds).
  onPlayerDeath?(api: PluginApi, player: PluginPlayer): void;
  // OT3-174: a heal (Restore Health) landed on another player; true = it revived them.
  onPlayerRevive?(api: PluginApi, healer: PluginPlayer, victimId: number): boolean | void;
  // M6: sharing policy per quest family. Return true to share (relay + one global copy),
  // false for individual mode (stored per-player, never relayed). The `sharing` builtin
  // answers from [sharing]; replace it for party/faction-scoped rules.
  onShareFamily?(api: PluginApi, family: ShareFamily): boolean | void;
  // M6: may this quest's journal index go DOWN? Default is monotonic-max arbitration.
  onJournalRegress?(api: PluginApi, questId: string): boolean | void;
  // M5: pre-route gate for a PLAYER-targeted CombatHit/CombatSpellHit. Return false to
  // drop it (the pvp builtin implements the [rules] pvp switch; operators can replace it
  // with faction/team logic). Actor-targeted hits never reach this hook.
  onPlayerHit?(api: PluginApi, attacker: PluginPlayer, victimId: number, name: string): boolean | void;
  // Pre-broadcast; return false to veto the chat line.
  onChat?(api: PluginApi, player: PluginPlayer, text: string): boolean | void;
  // M8: per-command veto applied AFTER the rank gate (the `admin` builtin uses it for
  // [admin] allowConsole). Return false to refuse; anything else allows.
  onAdminCommand?(api: PluginApi, actor: PluginPlayer, cmd: string): boolean | void;
}
