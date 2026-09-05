// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M8 operator commands (PROTOCOL.md §M8). ONE implementation serves both entry points —
// the `/slash` chat path and the `AdminCommand` event — so a rank gate can never be
// enforced on one and forgotten on the other.
//
// Ranks (stored on the account, 0-3):
//   0 player     nothing privileged
//   1 moderator  kick, tp, tpto, reports, chatlog  (crowd control + evidence)
//   2 admin      ban, unban, ipban, give, motd  (state + access control)
//   3 owner      setrank, console                (privilege escalation + remote code)
//
// `console` ships arbitrary Lua to a player's own machine, so it is owner-only, can be
// switched off entirely ([admin] allowConsole=false), and every use is logged with actor,
// target and the full payload. Refusals are explicit ("/ban requires rank 2, you are 1")
// rather than "unknown command": a moderator who cannot ban should learn that, and hiding
// the command's existence buys nothing when the command list is in the protocol doc.

import type { Player, Roster } from './players';
import type { AccountStore } from './accounts';
import type { BanStore } from '../persist/banstore';
import type { ResumeStore } from './resume';
import type { Moderation } from './moderation';
import { broadcastChat } from './chat';
import { log } from '../log';

export const RANK_NAMES: Record<number, string> = { 0: 'player', 1: 'moderator', 2: 'admin', 3: 'owner' };
export const MAX_RANK = 3;

const MAX_ARG = 256;
const MAX_SCRIPT = 4096;
// A4: an admin answer is whispered line-by-line over the chat tier, so an unbounded
// /chatlog would be a self-inflicted flood. Bound the reply, not the stored data.
const MAX_REPORT_LIST = 50;
const MAX_CHATLOG_LINES = 40;
const MAX_CHATLOG_MINUTES = 60 * 24 * 7;

export interface AdminCtx {
  roster: Roster;
  accounts: AccountStore;
  bans: BanStore;
  resume: ResumeStore;
  moderation: Moderation;
  // Phase 4 quest repair (absent on worlds that do not load it).
  questRepair?: {
    inspect(charId: string): { journal: Record<string, number>; globals: Record<string, number> };
    setStage(charId: string, questId: string, index: number, by: string): boolean;
    clearSpawnCooldowns(charId: string, by: string): void;
  };
  allowConsole: boolean;
  motd: () => string;
  setMotd(text: string): void;
  // Plugin veto: false = this actor may not run this command (default allow).
  allow(actor: Player, cmd: string): boolean;
}

/** The commands a rank may run, one line each. The dashboard's catalog is the same table. */
export function adminHelpLines(rank: number): string[] {
  return Object.entries(ADMIN_COMMANDS)
    .filter(([, spec]) => rank >= spec.minRank)
    .map(([, spec]) => `${spec.usage} — ${spec.help}`);
}

interface AdminCommandSpec {
  minRank: number;
  usage: string;
  help: string;
  run(ctx: AdminCtx, actor: Player, args: string[]): string | Promise<string>;
}

function targetOf(ctx: AdminCtx, name: string | undefined): Player | undefined {
  return name ? ctx.roster.findByName(name) : undefined;
}

// Everything a player can name is untrusted text: bound it before it reaches a filename,
// a log line or another client's screen.
function arg(args: string[], i: number): string | undefined {
  const v = args[i];
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ARG ? v : undefined;
}

export const ADMIN_COMMANDS: Record<string, AdminCommandSpec> = {
  // The capability query, rank-filtered from this same table so it cannot drift from the
  // gate that enforces it.
  help: {
    minRank: 0,
    usage: '/help',
    help: 'list the commands your rank permits',
    run(_ctx, actor) {
      return adminHelpLines(actor.rank).join('\n');
    },
  },
  list: {
    minRank: 0,
    usage: '/list',
    help: 'list players in world with id, rank and cell',
    run(ctx) {
      const players = ctx.roster.inWorld();
      if (players.length === 0) return 'No players in world.';
      return players
        .map((p) => `#${p.id} ${p.name} [${RANK_NAMES[p.rank] ?? p.rank}] ${p.cellKey ?? '-'}`)
        .join('\n');
    },
  },
  motd: {
    minRank: 0, // reading is public; SETTING is gated below (rank 2)
    usage: '/motd [text]',
    help: 'show the message of the day, or set it (rank 2)',
    run(ctx, actor, args) {
      const text = args.join(' ').trim();
      if (!text) return `MOTD: ${ctx.motd()}`;
      if (actor.rank < 2) return refusal('motd', 2, actor.rank);
      if (text.length > 512) return 'MOTD too long (max 512 chars).';
      ctx.setMotd(text);
      broadcastChat(ctx.roster, { channel: 'server', text });
      audit(actor, 'motd', { text });
      return `MOTD set to: ${text}`;
    },
  },
  reports: {
    minRank: 1,
    usage: '/reports [n]',
    help: 'list the most recent player reports (moderator)',
    async run(ctx, _actor, args) {
      const n = args[0] === undefined ? 10 : Number(args[0]);
      if (!Number.isInteger(n) || n < 1 || n > MAX_REPORT_LIST) return `usage: /reports [1-${MAX_REPORT_LIST}]`;
      const found = await ctx.moderation.reports.list(n);
      if (found.length === 0) return 'No reports on file.';
      return found
        .map(({ file, doc }) =>
          `${doc.ts} ${doc.reporter.name} -> ${doc.target.name}` +
          ` @${doc.target.cellKey ?? '?'}: ${doc.reason.slice(0, 120)}  [${file}]`)
        .join('\n');
    },
  },
  // Phase 4: the quest-unstick tool. Stuck quests are inevitable in a system covering
  // 300+ vanilla quests written for one player — Skyrim Together shipped an F3 debugger
  // for exactly this reason — so repair is a first-class feature, not an admission.
  //
  // Rank 0 for the READ: a player looking at their own quest state needs no permission,
  // and is the fastest way for them to tell a moderator what is wrong.
  quest: {
    minRank: 0,
    usage: '/quest [player] | /quest set <player> <questId> <index>',
    help: 'inspect quest state, or (moderator) force a stage when a quest is stuck',
    async run(ctx, actor, args) {
      if (!ctx.questRepair) return 'Quest repair is not available on this world.';
      const sub = args[0] ?? '';
      if (sub === 'set') {
        if (actor.rank < 1) return 'Only a moderator can force a quest stage.';
        const [, who, questId, raw] = args;
        if (!who || !questId || raw === undefined) return 'usage: /quest set <player> <questId> <index>';
        const target = ctx.roster.findByName(who);
        if (!target) return `${who} is not online.`;
        const index = Number(raw);
        if (!ctx.questRepair.setStage(target.charId, questId, index, actor.name)) {
          return 'Index must be a whole number.';
        }
        // Cooldowns go too: the usual reason a stage is forced is that an encounter never
        // appeared, and leaving the cooldown would block the retry.
        ctx.questRepair.clearSpawnCooldowns(target.charId, actor.name);
        return `Set ${target.name}'s ${questId} to ${index} (spawn cooldowns cleared).`;
      }
      const who = sub === '' ? actor.name : sub;
      if (sub !== '' && actor.rank < 1 && who.toLowerCase() !== actor.name.toLowerCase()) {
        return 'You can only inspect your own quests.';
      }
      const target = ctx.roster.findByName(who);
      if (!target) return `${who} is not online.`;
      const state = ctx.questRepair.inspect(target.charId);
      const entries = Object.entries(state.journal).sort(([a], [b]) => a.localeCompare(b));
      if (entries.length === 0) return `${target.name} has no journal entries.`;
      return entries.slice(0, 40).map(([q, i]) => `${q} = ${i}`).join('\n');
    },
  },
  chatlog: {
    minRank: 1,
    usage: '/chatlog <player> [minutes]',
    help: 'read one player\'s recent chat (moderator)',
    async run(ctx, _actor, args) {
      const name = arg(args, 0);
      if (!name) return 'usage: /chatlog <player> [minutes]';
      const minutes = args[1] === undefined ? 15 : Number(args[1]);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_CHATLOG_MINUTES) {
        return `minutes must be an integer 1-${MAX_CHATLOG_MINUTES}.`;
      }
      const lines = await ctx.moderation.chat.readRecent(minutes, name);
      if (lines.length === 0) return `No chat from "${name}" in the last ${minutes} min.`;
      // Tail, not head: the interesting part of an incident is always the end of it.
      return lines
        .slice(-MAX_CHATLOG_LINES)
        .map((l) => `${l.ts} [${l.channel}] ${l.name}: ${l.text}`)
        .join('\n');
    },
  },
  kick: {
    minRank: 1,
    usage: '/kick <player> [reason]',
    help: 'disconnect a player (they may reconnect)',
    run(ctx, actor, args) {
      const name = arg(args, 0);
      const target = targetOf(ctx, name);
      if (!target) return name ? `No player named "${name}".` : 'usage: /kick <player> [reason]';
      if (target.rank > actor.rank) return `${target.name} outranks you.`;
      const reason = args.slice(1).join(' ').slice(0, MAX_ARG) || `kicked by ${actor.name}`;
      target.peer.disconnect('KICKED', reason);
      audit(actor, 'kick', { target: target.name, reason });
      return `Kicked ${target.name}: ${reason}`;
    },
  },
  tp: {
    minRank: 1,
    usage: '/tp <player>',
    help: 'teleport a player to you',
    run(ctx, actor, args) {
      const name = arg(args, 0);
      const target = targetOf(ctx, name);
      if (!target) return name ? `No player named "${name}".` : 'usage: /tp <player>';
      if (!actor.cellKey || !actor.pose) return 'You are not in a cell yet.';
      if (target.id === actor.id) return 'You are already there.';
      sendTeleport(target, actor.cellKey, actor.pose);
      audit(actor, 'tp', { target: target.name, cellKey: actor.cellKey });
      return `Teleported ${target.name} to you.`;
    },
  },
  tpto: {
    minRank: 1,
    usage: '/tpto <player>',
    help: 'teleport yourself to a player',
    run(ctx, actor, args) {
      const name = arg(args, 0);
      const target = targetOf(ctx, name);
      if (!target) return name ? `No player named "${name}".` : 'usage: /tpto <player>';
      if (!target.cellKey || !target.pose) return `${target.name} is not in a cell yet.`;
      if (target.id === actor.id) return 'You are already there.';
      sendTeleport(actor, target.cellKey, target.pose);
      audit(actor, 'tpto', { target: target.name, cellKey: target.cellKey });
      return `Teleporting you to ${target.name}.`;
    },
  },
  give: {
    minRank: 2,
    usage: '/give <player> <recordId> [count]',
    help: 'add an item to a player\'s inventory',
    run(ctx, actor, args) {
      const name = arg(args, 0);
      const recordId = arg(args, 1);
      const target = targetOf(ctx, name);
      if (!target || !recordId) return 'usage: /give <player> <recordId> [count]';
      const count = args[2] === undefined ? 1 : Number(args[2]);
      if (!Number.isInteger(count) || count < 1 || count > 10000) return 'count must be an integer 1-10000.';
      target.peer.sendEvent('AdminGive', { recordId, count });
      audit(actor, 'give', { target: target.name, recordId, count });
      return `Gave ${count}x ${recordId} to ${target.name}.`;
    },
  },
  ban: {
    minRank: 2,
    usage: '/ban <account> [reason]',
    help: 'ban an account (kicks them if online)',
    async run(ctx, actor, args) {
      const name = arg(args, 0);
      if (!name) return 'usage: /ban <account> [reason]';
      const account = await ctx.accounts.get(ctx.accounts.keyForUsername(name) ?? name);
      if (!account) return `No account named "${name}".`;
      const online = ctx.roster.findByName(account.name);
      if (online && online.rank > actor.rank) return `${online.name} outranks you.`;
      if (account.rank > actor.rank) return `${account.name} outranks you.`;
      const reason = args.slice(1).join(' ').slice(0, MAX_ARG) || `banned by ${actor.name}`;
      ctx.bans.banAccount(account.name, actor.name, reason);
      ctx.accounts.setBanned(account.name, true);
      ctx.resume.revokeAccount(account.name.toLowerCase()); // no rejoin-in-place for a banned account
      online?.peer.disconnect('BANNED', reason);
      audit(actor, 'ban', { target: account.name, reason });
      return `Banned ${account.name}: ${reason}`;
    },
  },
  unban: {
    minRank: 2,
    usage: '/unban <account|ip>',
    help: 'lift an account or IP ban',
    async run(ctx, actor, args) {
      const name = arg(args, 0);
      if (!name) return 'usage: /unban <account|ip>';
      const lifted = ctx.bans.unbanAccount(name);
      const liftedIp = ctx.bans.unbanIp(name);
      // Load the account first: setBanned only touches the cache, and after a restart the
      // account is not in it — without this the ban list would say "lifted" while
      // accounts/<name>.json still carried banned:true and every login stayed refused.
      if (lifted && (await ctx.accounts.get(name))) ctx.accounts.setBanned(name, false);
      if (!lifted && !liftedIp) return `"${name}" is not banned.`;
      audit(actor, 'unban', { target: name, account: lifted, ip: liftedIp });
      return `Unbanned ${name}${liftedIp ? ' (IP)' : ''}.`;
    },
  },
  ipban: {
    minRank: 2,
    usage: '/ipban <player|ip> [reason]',
    help: 'ban the address of an online player, or a literal IP',
    run(ctx, actor, args) {
      const who = arg(args, 0);
      if (!who) return 'usage: /ipban <player|ip> [reason]';
      const target = ctx.roster.findByName(who);
      const ip = target?.ip ?? who;
      if (target && target.rank > actor.rank) return `${target.name} outranks you.`;
      if (!target && !looksLikeIp(who)) return `No online player named "${who}" and "${who}" is not an IP.`;
      const reason = args.slice(1).join(' ').slice(0, MAX_ARG) || `ip-banned by ${actor.name}`;
      ctx.bans.banIp(ip, actor.name, reason);
      for (const p of ctx.roster.inWorld()) if (p.ip === ip) p.peer.disconnect('BANNED', reason);
      audit(actor, 'ipban', { ip, target: target?.name, reason });
      return `IP-banned ${ip}: ${reason}`;
    },
  },
  setrank: {
    minRank: 3,
    usage: '/setrank <account> <0-3>',
    help: 'set an account rank (owner only)',
    async run(ctx, actor, args) {
      const name = arg(args, 0);
      const rank = args[1] === undefined ? NaN : Number(args[1]);
      if (!name || !Number.isInteger(rank) || rank < 0 || rank > MAX_RANK) {
        return `usage: /setrank <account> <0-${MAX_RANK}>`;
      }
      const account = await ctx.accounts.get(name);
      if (!account) return `No account named "${name}".`;
      ctx.accounts.setRank(account.name, rank);
      // A live session must feel it immediately, not at next login.
      const online = ctx.roster.findByName(account.name);
      if (online) online.rank = rank;
      audit(actor, 'setrank', { target: account.name, rank });
      return `${account.name} is now ${RANK_NAMES[rank]} (${rank}).`;
    },
  },
  console: {
    minRank: 3,
    usage: '/console <player> <script>',
    help: 'run a script on a player\'s client (owner only)',
    run(ctx, actor, args) {
      if (!ctx.allowConsole) return 'Console execution is disabled on this server ([admin] allowConsole).';
      const name = arg(args, 0);
      const target = targetOf(ctx, name);
      const script = args.slice(1).join(' ');
      if (!target || !script) return 'usage: /console <player> <script>';
      if (script.length > MAX_SCRIPT) return `script too long (max ${MAX_SCRIPT} chars).`;
      target.peer.sendEvent('ConsoleCommand', { script });
      // Remote code execution on someone else's machine: the audit line carries the FULL
      // payload on purpose, so an operator reading logs can reconstruct exactly what ran.
      log('warn', 'admin.console', { actor: actor.name, actorId: actor.id, target: target.name, script });
      return `Sent to ${target.name}: ${script}`;
    },
  },
};

function looksLikeIp(s: string): boolean {
  // Both alternatives REQUIRE a separator. Without it, any name spelled in hex ("Facade",
  // "dead") or digits ("1234" — a legal username) passed as an address: the name was banned
  // as a literal IP string, the roster loop matched nobody, and the operator was told it
  // worked. A real address always carries '.' or ':'.
  return /^(?=.*\.)[0-9.]+$/.test(s) || /^(?=.*[.:])[0-9a-fA-F:.]+$/.test(s);
}

function sendTeleport(player: Player, cellKey: string, pose: { x: number; y: number; z: number }): void {
  player.peer.sendEvent('AdminTeleport', { cellKey, x: pose.x, y: pose.y, z: pose.z });
}

function refusal(cmd: string, need: number, have: number): string {
  return `/${cmd} requires rank ${need} (${RANK_NAMES[need]}); you are rank ${have} (${RANK_NAMES[have] ?? have}).`;
}

function audit(actor: Player, cmd: string, fields: Record<string, unknown>): void {
  log('info', 'admin.action', { actor: actor.name, actorId: actor.id, cmd, ...fields });
}

export class Admin {
  constructor(private readonly ctx: AdminCtx) {}

  known(cmd: string): boolean {
    return Object.hasOwn(ADMIN_COMMANDS, cmd);
  }

  helpLines(rank: number): string[] {
    return adminHelpLines(rank);
  }

  // THE ONE GATE. Operator commands enter only through the dashboard (server.ts runCommand,
  // behind POST /admin/api/command); there is no typed or in-game route. Never throws: a
  // failure comes back as text the caller shows the actor.
  async exec(actor: Player, cmd: string, args: string[]): Promise<string> {
    const spec = ADMIN_COMMANDS[cmd];
    if (!spec) return `Unknown command /${cmd}.`;
    if (actor.rank < spec.minRank) {
      log('warn', 'admin.refused', { actor: actor.name, cmd, rank: actor.rank, need: spec.minRank });
      return refusal(cmd, spec.minRank, actor.rank);
    }
    if (!this.ctx.allow(actor, cmd)) {
      log('warn', 'admin.vetoed', { actor: actor.name, cmd });
      return `/${cmd} is not permitted for you on this server.`;
    }
    try {
      return await spec.run(this.ctx, actor, args);
    } catch (err) {
      log('error', 'admin.failed', { actor: actor.name, cmd, error: String(err) });
      return `/${cmd} failed: internal error.`;
    }
  }

}
