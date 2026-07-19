// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Plugin surface: lifecycle + gameplay hooks and a small action API. Built-ins only in
// M0; the shapes are the contract later external plugins will get.

import type { Config } from '../config';
import type { LogLevel } from '../log';
import type { ChatMessageBody } from '../core/chat';

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
}

export interface Plugin {
  name: string;
  onServerStart?(api: PluginApi): void;
  onServerStop?(api: PluginApi): void;
  onPlayerAuthed?(api: PluginApi, player: PluginPlayer): void;
  onPlayerJoinWorld?(api: PluginApi, player: PluginPlayer): void;
  onPlayerDisconnect?(api: PluginApi, player: PluginPlayer): void;
  // Pre-broadcast; return false to veto the chat line.
  onChat?(api: PluginApi, player: PluginPlayer, text: string): boolean | void;
  // Return true to mark the command handled (skips the core registry).
  onCommand?(api: PluginApi, player: PluginPlayer, name: string, args: string): boolean | void;
}
