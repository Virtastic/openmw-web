// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Plugin surface: lifecycle + gameplay hooks and a small action API. Built-ins only in
// M0; the shapes are the contract later external plugins will get.

import type { Config } from '../config';
import type { LogLevel } from '../log';
import type { ChatMessageBody } from '../core/chat';
import type { JsLike } from '../proto/lser';
import type { ShareFamily } from '../core/quests';
import type { GuiResult } from '../core/gui';

// M7 server-pushed GUI. Each call resolves when the player answers, times out
// ([gui] timeoutSec), or disconnects — it NEVER stays pending, so a plugin awaiting a
// reply from someone who rage-quit resumes instead of leaking.
export interface PluginGui {
  messageBox(playerId: number, text: string, buttons?: string[]): Promise<GuiResult>;
  inputDialog(playerId: number, label: string): Promise<GuiResult>;
  listBox(playerId: number, label: string, items: string[]): Promise<GuiResult>;
}

// M7 world actions: the operator-facing clock and cell-reset controls.
export interface PluginWorld {
  time(): { gameHour: number; day: number; month: number; year: number; timeScale: number };
  advanceTime(hours: number): void;
  setTimeScale(scale: number): void;
  scheduleCellReset(cellKey: string, intervalSec: number): boolean;
  unscheduleCellReset(cellKey: string): void;
  scheduledResets(): string[];
  resetCell(cellKey: string): Promise<void>;
  // M8: promote an existing account to owner (rank 3). Resolves false if unknown.
  promoteOwner(account: string): Promise<boolean>;
  // Dialogs still awaiting a reply. Settles to 0 once every prompt is answered, timed
  // out or orphaned by a disconnect — an operator-visible leak check.
  pendingGuiCount(): number;
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
  gui: PluginGui; // M7
  world: PluginWorld; // M7
  // Phase 3 rule helpers. Optional so an embedder can supply a partial api in tests
  // without every plugin needing to care.
  arePartied?(aPlayerId: number, bPlayerId: number): boolean;
  cellOfPlayer?(playerId: number): string | undefined;
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
  // Return true to mark the command handled (skips the core registry).
  onCommand?(api: PluginApi, player: PluginPlayer, name: string, args: string): boolean | void;
  // M8: per-command veto applied AFTER the rank gate (the `admin` builtin uses it for
  // [admin] allowConsole). Return false to refuse; anything else allows.
  onAdminCommand?(api: PluginApi, actor: PluginPlayer, cmd: string): boolean | void;
}
