// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Slash-command registry. Core set: /help /me; M8 adds every operator command from
// core/admin.ts (one implementation, shared with the AdminCommand event path). Plugins
// get first crack via the onCommand hook (return true = handled).

import type { Player, Roster } from './players';
import { Admin, ADMIN_COMMANDS } from './admin';
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
  minRank: number; // used for /help visibility, and for gating unless selfGated
  // M8 admin commands rank-check inside Admin.exec so the chat and event paths share ONE
  // gate (and one refusal wording); the registry must not pre-empt them.
  selfGated?: boolean;
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
    if (!cmd.selfGated && player.rank < cmd.minRank) {
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
}

// M8: expose every ADMIN_COMMANDS entry as a slash command. The registry only supplies
// discovery (/help) and argument splitting; authority, auditing and refusal wording all
// live in Admin.exec.
export function registerAdminCommands(registry: CommandRegistry, admin: Admin): void {
  for (const [name, spec] of Object.entries(ADMIN_COMMANDS)) {
    registry.register({
      name,
      help: spec.help,
      minRank: spec.minRank,
      selfGated: true,
      run(_ctx, player, args) {
        void admin.exec(player, name, splitArgs(args)).then((text) => {
          for (const line of text.split('\n')) serverWhisper(player, line);
        });
      },
    });
  }
}

// Whitespace split, but the LAST argument of a script-carrying command keeps its spaces
// because Admin joins the tail itself (/console <player> <script>).
function splitArgs(args: string): string[] {
  return args.length === 0 ? [] : args.split(/\s+/);
}
