// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Hook bus over the built-in plugin registry. Static imports (the bundle can't
// dynamic-import by path); config `plugins` selects and orders them. A throwing
// plugin is logged and skipped — never fatal.

import type { Plugin, PluginApi, PluginPlayer } from './api';
import { motd } from './builtin/motd';
import { respawn } from './builtin/respawn';
import { deathPenalty } from './builtin/death-penalty';
import { pvp } from './builtin/pvp';
import { log } from '../log';

const BUILTINS: Record<string, Plugin> = { motd, respawn, 'death-penalty': deathPenalty, pvp };

export class HookBus {
  private plugins: Plugin[] = [];

  constructor(
    names: string[],
    private readonly api: PluginApi,
  ) {
    for (const name of names) {
      const plugin = BUILTINS[name];
      if (!plugin) {
        log('warn', 'plugins.unknown', { name });
        continue;
      }
      this.plugins.push(plugin);
      log('info', 'plugins.loaded', { name });
    }
  }

  private run(hook: string, fn: (p: Plugin) => unknown): unknown {
    for (const plugin of this.plugins) {
      try {
        const result = fn(plugin);
        if (result !== undefined) return result;
      } catch (err) {
        log('error', 'plugins.hook_error', { plugin: plugin.name, hook, error: String(err) });
      }
    }
    return undefined;
  }

  serverStart(): void {
    this.run('onServerStart', (p) => void p.onServerStart?.(this.api));
  }
  serverStop(): void {
    this.run('onServerStop', (p) => void p.onServerStop?.(this.api));
  }
  playerAuthed(player: PluginPlayer): void {
    this.run('onPlayerAuthed', (p) => void p.onPlayerAuthed?.(this.api, player));
  }
  playerJoinWorld(player: PluginPlayer): void {
    this.run('onPlayerJoinWorld', (p) => void p.onPlayerJoinWorld?.(this.api, player));
  }
  playerDisconnect(player: PluginPlayer): void {
    this.run('onPlayerDisconnect', (p) => void p.onPlayerDisconnect?.(this.api, player));
  }
  playerDeath(player: PluginPlayer): void {
    this.run('onPlayerDeath', (p) => void p.onPlayerDeath?.(this.api, player));
  }
  // false = vetoed (player-targeted combat only).
  playerHit(attacker: PluginPlayer, victimId: number, name: string): boolean {
    return this.run('onPlayerHit', (p) => p.onPlayerHit?.(this.api, attacker, victimId, name)) !== false;
  }
  // false = vetoed.
  chat(player: PluginPlayer, text: string): boolean {
    return this.run('onChat', (p) => p.onChat?.(this.api, player, text)) !== false;
  }
  // true = handled by a plugin.
  command(player: PluginPlayer, name: string, args: string): boolean {
    return this.run('onCommand', (p) => p.onCommand?.(this.api, player, name, args)) === true;
  }
}
