// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Slash-command registry. Core set: /help /list /me, plus rank-gated /kick as the
// admin seed (rank >= 1, set by editing the account JSON in M0). Plugins get first
// crack via the onCommand hook (return true = handled).

import type { Player, Roster } from './players';
import { broadcastChat, serverWhisper } from './chat';
import { log } from '../log';

export interface CommandContext {
  roster: Roster;
  // Plugin hook: true = a plugin handled the command.
  onCommand(player: Player, name: string, args: string): boolean;
}

export interface Command {
  name: string;
  help: string;
  minRank: number;
  run(ctx: CommandContext, player: Player, args: string): void;
}

export class CommandRegistry {
  private commands = new Map<string, Command>();

  register(cmd: Command): void {
    this.commands.set(cmd.name, cmd);
  }

  dispatch(ctx: CommandContext, player: Player, line: string): void {
    const body = line.slice(1); // drop "/"
    const space = body.indexOf(' ');
    const name = (space === -1 ? body : body.slice(0, space)).toLowerCase();
    const args = space === -1 ? '' : body.slice(space + 1).trim();
    if (ctx.onCommand(player, name, args)) return;
    const cmd = this.commands.get(name);
    if (!cmd) {
      serverWhisper(player, `Unknown command /${name} — try /help`);
      return;
    }
    if (player.rank < cmd.minRank) {
      serverWhisper(player, `/${cmd.name} requires a higher rank`);
      return;
    }
    log('info', 'command', { from: player.name, name, args });
    cmd.run(ctx, player, args);
  }

  helpLines(rank: number): string[] {
    return [...this.commands.values()].filter((c) => rank >= c.minRank).map((c) => `/${c.name} — ${c.help}`);
  }
}

export function registerCoreCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'help',
    help: 'list available commands',
    minRank: 0,
    run(_ctx, player) {
      for (const line of registry.helpLines(player.rank)) serverWhisper(player, line);
    },
  });
  registry.register({
    name: 'list',
    help: 'list players in world',
    minRank: 0,
    run(ctx, player) {
      const names = ctx.roster.inWorld().map((p) => p.name);
      serverWhisper(player, `Players (${names.length}): ${names.join(', ')}`);
    },
  });
  registry.register({
    name: 'me',
    help: 'emote: /me waves',
    minRank: 0,
    run(ctx, player, args) {
      if (!args) {
        serverWhisper(player, 'usage: /me <action>');
        return;
      }
      broadcastChat(ctx.roster, {
        channel: 'say',
        from: player.name,
        fromId: player.id,
        text: `* ${player.name} ${args}`,
      });
    },
  });
  registry.register({
    name: 'kick',
    help: 'kick a player by name (admin)',
    minRank: 1,
    run(ctx, player, args) {
      const target = args ? ctx.roster.findByName(args) : undefined;
      if (!target) {
        serverWhisper(player, args ? `No player named "${args}"` : 'usage: /kick <name>');
        return;
      }
      target.peer.disconnect('KICKED', `kicked by ${player.name}`);
    },
  });
}
