// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Slash-command registry. Core set: /help /me; M8 adds every operator command from
// core/admin.ts (one implementation, shared with the AdminCommand event path). Plugins
// get first crack via the onCommand hook (return true = handled).

import type { Player, Roster } from './players';
import { Admin, ADMIN_COMMANDS } from './admin';
import { broadcastChat, serverWhisper } from './chat';
import { MAX_REASON_CHARS, type Moderation } from './moderation';
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

// A4: /report is the one moderation command a rank-0 player may run, so it lives in the
// plain registry rather than ADMIN_COMMANDS (which is the operator surface). It is
// deliberately cheap to file and expensive to abuse: the reporter's own name is stamped on
// every report, and the reason is bounded before it ever reaches a filename or a JSON doc.
export function registerReportCommand(registry: CommandRegistry, mod: Moderation): void {
  registry.register({
    name: 'report',
    help: 'report a player to the operators: /report <player> <reason>',
    minRank: 0,
    run(ctx, player, args) {
      const space = args.indexOf(' ');
      const targetName = space === -1 ? args : args.slice(0, space);
      const reason = space === -1 ? '' : args.slice(space + 1).trim().slice(0, MAX_REASON_CHARS);
      if (!targetName || !reason) {
        serverWhisper(player, 'usage: /report <player> <reason>');
        return;
      }
      // An offline target is still reportable (they may have just logged off after
      // griefing), so a miss records the name rather than refusing.
      const target = ctx.roster.findByName(targetName);
      void mod.reports
        .write({
          ts: new Date().toISOString(),
          reporter: { id: player.id, name: player.name, account: player.accountKey },
          target: {
            id: target?.id ?? null,
            name: target?.name ?? targetName.slice(0, 64),
            account: target?.accountKey ?? null,
            cellKey: target?.cellKey ?? null,
          },
          reason,
          context: mod.chat.context(),
        })
        .then((file) => {
          log('info', 'moderation.report', { reporter: player.name, target: targetName, file });
          serverWhisper(player, `Report filed against ${targetName}. Thank you.`);
        })
        .catch((err) => {
          // Never swallow: the player is told it failed AND the operator sees why.
          log('error', 'moderation.report_failed', { reporter: player.name, error: String(err) });
          serverWhisper(player, 'Could not file that report — please tell an operator directly.');
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
