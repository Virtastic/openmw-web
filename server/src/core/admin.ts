// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M8 operator commands (PROTOCOL.md §M8). ONE implementation serves both entry points —
// the `/slash` chat path and the `AdminCommand` event — so a rank gate can never be
// enforced on one and forgotten on the other.
//
// Ranks (stored on the account, 0-3):
//   0 player     nothing privileged
//   1 moderator  kick, tp, tpto, reports, triage, chatlog, mute  (crowd control + evidence)
//   2 admin      ban, unban, ipban, give, motd  (state + access control)
//   3 owner      setrank, console                (privilege escalation + remote code)
//
// `console` ships arbitrary Lua to a player's own machine, so it is owner-only, can be
// switched off entirely ([admin] allowConsole=false), and every use is logged with actor,
// target and the full payload. Refusals are explicit ("/ban requires rank 2, you are 1")
// rather than "unknown command": a moderator who cannot ban should learn that, and hiding
// the command's existence buys nothing when the command list is in the protocol doc.

import type { AuditRow, LoginLog } from './admin-audit';
import type { Player, Roster } from './players';
import type { AccountStore, DashboardRole } from './accounts';
import type { BanStore } from '../persist/banstore';
import type { ResumeStore } from './resume';
import type { Moderation } from './moderation';
import { broadcastChat } from './chat';
import { log } from '../log';

// OT3-191: 1 is the helper tier (kick, mute, reports); 2 adds bans, give and restore.
// 4 is the platform itself (the gateway's erase-kick) and is never assignable.
const RANK_NAMES: Record<number, string> = { 0: 'player', 1: 'moderator', 2: 'admin', 3: 'owner', 4: 'platform' };
const MAX_RANK = 3;

export const PLATFORM_ACTOR = '(platform)';
const SHARED_TOKEN_ACTOR = '(shared-token)';

// OT3-191: what a dashboard role may do in game terms. A plain dashboard moderator is a
// rank-1 helper; one whose account ALSO holds in-game rank 2 keeps it. Only owner is 3.
export function dashboardRank(role: DashboardRole | undefined, accountRank = 0): number {
  return role === 'owner' ? 3 : role === 'moderator' ? Math.min(2, Math.max(1, accountRank)) : 0;
}

// The rank of a dashboard principal, from its ACCOUNT -- never from a role the request
// carried. An unknown name is rank 0: fail closed.
export async function operatorRank(accounts: Pick<AccountStore, 'get' | 'keyForUsername'>, name: string): Promise<number> {
  if (name === PLATFORM_ACTOR) return 4;
  if (name === SHARED_TOKEN_ACTOR) return 1;
  const a = await accounts.get(accounts.keyForUsername(name) ?? name.toLowerCase());
  return dashboardRank(a?.dashboardRole, a?.rank);
}

// OT3-191: staff act only on people BELOW them; equal rank is refused too (a moderator
// cannot kick or mute another moderator). Acting on yourself stays allowed.
function outranks(rank: number, name: string, actor: Player): boolean {
  return rank >= actor.rank && name.toLowerCase() !== actor.name.toLowerCase();
}

const MAX_ARG = 256;
const BAN_USAGE = '/ban <account> [30m|12h|7d|perm] <reason>';
const IPBAN_USAGE = '/ipban <player|ip> [30m|12h|7d|perm] <reason>';
const MAX_SCRIPT = 4096;
// A4: an admin answer is whispered line-by-line over the chat tier, so an unbounded
// /chatlog would be a self-inflicted flood. Bound the reply, not the stored data.
const MAX_REPORT_LIST = 50;
const MAX_CHATLOG_LINES = 40;
const MAX_CHATLOG_MINUTES = 60 * 24 * 7;

interface AdminCtx {
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
  // OT3-67: staff revoke/restore of Novice-channel mentor status (Social.setMentor).
  setMentor?(player: Player, state: 'revoked' | 'off'): string;
  motd: () => string;
  setMotd(text: string): void;
  // Plugin veto: false = this actor may not run this command (default allow).
  allow(actor: Player, cmd: string): boolean;
  // OT3-183: the durable audit table (admin-audit.ts). Absent in tests that do not care.
  audit?: { write(row: AuditRow): void };
  // OT3-184: point-in-time character restore (PlayerStore.restoreTo).
  restore?(charKey: string, at: number): number | undefined;
  // OT3-185: the moderator mute (Social.setServerMuted); until = epoch ms, absent = permanent.
  setMuted?(accountKey: string, muted: boolean, until?: number, reason?: string): void;
  // OT3-186: login history (admin-audit.ts LoginLog). Absent = /logins reports it is off.
  logins?: LoginLog;
}

const MAX_MUTE_MINUTES = 60 * 24 * 30;

// A mute may land on someone offline (the usual case: they spammed and left), so it resolves
// the ACCOUNT like /ban does, not an online player.
async function muteTarget(ctx: AdminCtx, actor: Player, name: string): Promise<{ key: string; name: string; online?: Player } | string> {
  const key = ctx.accounts.keyForUsername(name) ?? name.toLowerCase();
  const account = await ctx.accounts.get(key);
  if (!account) return `No account named "${name}".`;
  const online = ctx.roster.findByName(account.name);
  if (outranks(Math.max(online?.rank ?? 0, account.rank), account.name, actor)) return `${account.name} is not below your rank.`;
  return { key, name: account.name, online };
}

/** The commands a rank may run, one line each. The dashboard's catalog is the same table. */
function adminHelpLines(rank: number): string[] {
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
        .map(({ id, doc, status, assignee }) =>
          `#${id} [${status}${assignee ? ` ${assignee}` : ''}] ${doc.ts} ${doc.reporter.name} -> ${doc.target.name}` +
          ` @${doc.target.cellKey ?? '?'}: ${doc.reason.slice(0, 120)}` +
          (doc.context ?? []).slice(-5).map((l) => `\n    ${l.name} (${l.channel}): ${l.text.slice(0, 120)}`).join(''))
        .join('\n');
    },
  },
  // OT3-188: work a report. claim = assigned to you (or to [staff]); close keeps who had it.
  triage: {
    minRank: 1,
    usage: '/triage <report#> <claim|close|open> [staff]',
    help: 'claim, close or reopen a player report (moderator)',
    async run(ctx, actor, args) {
      const id = Number(String(args[0] ?? '').replace(/^#/, ''));
      const verb = args[1];
      const to = { claim: 'assigned', close: 'closed', open: 'open' } as const;
      if (!Number.isInteger(id) || id < 1 || !(verb === 'claim' || verb === 'close' || verb === 'open')) {
        return 'usage: /triage <report#> <claim|close|open> [staff]';
      }
      const who = verb === 'claim' ? (arg(args, 2) ?? actor.name) : verb === 'close' ? actor.name : undefined;
      // Close names the closer only when nobody had claimed it (COALESCE keeps a claimant).
      if (!ctx.moderation.reports.setStatus(id, to[verb], who)) return `No report #${id}.`;
      audit(actor, 'triage', { report: id, status: to[verb], assignee: who });
      return `Report #${id} is ${to[verb]}${who && verb === 'claim' ? ` (${who})` : ''}.`;
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
  mentor: {
    minRank: 1,
    usage: '/mentor <player> revoke|restore',
    help: 'revoke or restore a Novice-channel mentor (moderator)',
    run(ctx, actor, args) {
      const name = arg(args, 0);
      const target = targetOf(ctx, name);
      const sub = args[1];
      if (!target || (sub !== 'revoke' && sub !== 'restore')) {
        return name && !target ? `No player named "${name}".` : 'usage: /mentor <player> revoke|restore';
      }
      if (!ctx.setMentor) return 'Mentors are not available on this world.';
      // Restore clears the revoke to 'off': the player opts back in themselves.
      const r = ctx.setMentor(target, sub === 'revoke' ? 'revoked' : 'off');
      if (r !== 'ok') return `/mentor failed: ${r}`;
      audit(actor, 'mentor', { target: target.name, sub });
      return sub === 'revoke' ? `${target.name} can no longer mentor.` : `${target.name} may opt in as a mentor again.`;
    },
  },
  mute: {
    minRank: 1,
    usage: `/mute <account> <minutes 1-${MAX_MUTE_MINUTES}|perm> [reason]`,
    help: 'silence an account\'s chat everywhere; a timed mute lifts itself (moderator)',
    async run(ctx, actor, args) {
      const name = arg(args, 0);
      const span = args[1];
      const minutes = span === 'perm' ? 0 : Number(span);
      if (!name || !(span === 'perm' || (Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_MUTE_MINUTES))) {
        return `usage: /mute <account> <minutes 1-${MAX_MUTE_MINUTES}|perm> [reason]`;
      }
      if (!ctx.setMuted) return 'Mutes are not available on this world.';
      const t = await muteTarget(ctx, actor, name);
      if (typeof t === 'string') return t;
      const reason = args.slice(2).join(' ').slice(0, MAX_ARG) || `muted by ${actor.name}`;
      const until = minutes > 0 ? Date.now() + minutes * 60_000 : undefined;
      ctx.setMuted(t.key, true, until, reason);
      t.online?.peer.sendEvent('ChatMessage', {
        channel: 'server', text: `You are muted ${minutes > 0 ? `for ${minutes} min` : 'until a moderator lifts it'}: ${reason}`,
      });
      audit(actor, 'mute', { target: t.name, minutes: minutes || 'perm', reason });
      return `Muted ${t.name} ${minutes > 0 ? `for ${minutes} min` : 'permanently'}: ${reason}`;
    },
  },
  unmute: {
    minRank: 1,
    usage: '/unmute <account>',
    help: 'lift a moderator mute (moderator)',
    async run(ctx, actor, args) {
      const name = arg(args, 0);
      if (!name) return 'usage: /unmute <account>';
      if (!ctx.setMuted) return 'Mutes are not available on this world.';
      const t = await muteTarget(ctx, actor, name);
      if (typeof t === 'string') return t;
      ctx.setMuted(t.key, false);
      audit(actor, 'unmute', { target: t.name });
      return `Unmuted ${t.name}.`;
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
      if (outranks(target.rank, target.name, actor)) return `${target.name} is not below your rank.`;
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
    usage: '/give <player> <recordId> <count> <reason>',
    help: 'add an item to a player\'s inventory (the reason is audited)',
    run(ctx, actor, args) {
      const name = arg(args, 0);
      const recordId = arg(args, 1);
      const target = targetOf(ctx, name);
      // OT3-191: item creation is an economy event, so it always says why (the audit row keeps it).
      const reason = args.slice(3).join(' ').slice(0, MAX_ARG);
      if (!target || !recordId || !reason) return 'usage: /give <player> <recordId> <count> <reason>';
      const count = Number(args[2]);
      if (!Number.isInteger(count) || count < 1 || count > 10000) return 'count must be an integer 1-10000.';
      target.peer.sendEvent('AdminGive', { recordId, count });
      audit(actor, 'give', { target: target.name, recordId, count, reason });
      return `Gave ${count}x ${recordId} to ${target.name}.`;
    },
  },
  // OT3-184: put one character back to how it was N minutes ago. Online targets are
  // disconnected first (a live client would write its state straight back); the rejoin
  // loads the restored doc. Offline characters go by character key.
  restore: {
    minRank: 2,
    usage: '/restore <player|charKey> <minutesAgo> <reason>',
    help: 'restore one character to a snapshot from N minutes ago',
    run(ctx, actor, args) {
      const who = arg(args, 0);
      const minutes = Number(args[1]);
      if (!who || !Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 24 * 60 || !arg(args, 2)) {
        return 'usage: /restore <player|charKey> <minutesAgo 1-10080> <reason>';
      }
      if (!ctx.restore) return 'Restore is not available on this world.';
      const online = ctx.roster.findByName(who);
      if (online && outranks(online.rank, online.name, actor)) return `${online.name} is not below your rank.`;
      const charKey = online?.charId ?? who;
      if (online) {
        // Synchronous: the logout flush lands now, so the restore below is the last write.
        online.peer.disconnect('KICKED', `Your character was restored by ${actor.name}; rejoin to continue.`);
        ctx.resume.revokeAccount(online.accountKey); // after: teardown parks a resume ticket
      }
      const ts = ctx.restore(charKey, Date.now() - minutes * 60_000);
      if (ts === undefined) return `No snapshot of ${online?.name ?? who} from ${minutes} min ago or earlier.`;
      audit(actor, 'restore', { target: charKey, minutes, snapshot: new Date(ts).toISOString() });
      return `Restored ${online?.name ?? who} to ${new Date(ts).toISOString()}.`;
    },
  },
  ban: {
    minRank: 2,
    usage: BAN_USAGE,
    help: 'ban an account (kicks them if online); a timed ban lifts itself',
    async run(ctx, actor, args) {
      const name = arg(args, 0);
      const terms = banTerms(args);
      if (!name || !terms) return `usage: ${BAN_USAGE}`;
      const { reason, until } = terms;
      const account = await ctx.accounts.get(ctx.accounts.keyForUsername(name) ?? name);
      if (!account) return `No account named "${name}".`;
      const online = ctx.roster.findByName(account.name);
      if (outranks(Math.max(online?.rank ?? 0, account.rank), account.name, actor)) return `${account.name} is not below your rank.`;
      ctx.bans.banAccount(account.name, actor.name, reason, until);
      // The account flag is the permanent marker only: a timed ban lives in bans.db alone, so
      // it can lift itself there (every login path checks bans.db too).
      ctx.accounts.setBanned(account.name, !until);
      ctx.resume.revokeAccount(account.name.toLowerCase()); // no rejoin-in-place for a banned account
      online?.peer.disconnect('BANNED', reason);
      audit(actor, 'ban', { target: account.name, reason, until: until ? new Date(until).toISOString() : 'perm' });
      return `Banned ${account.name}${forSpan(until)}: ${reason}`;
    },
  },
  logins: {
    minRank: 2,
    usage: '/logins <account>',
    help: 'recent logins (time, character, address) and other accounts seen on the same addresses',
    async run(ctx, _actor, args) {
      const name = arg(args, 0);
      if (!name) return 'usage: /logins <account>';
      if (!ctx.logins) return 'Login history is not kept on this server.';
      const key = ctx.accounts.keyForUsername(name) ?? name.toLowerCase();
      const account = await ctx.accounts.get(key);
      if (!account) return `No account named "${name}".`;
      const rows = ctx.logins.recent(key);
      if (rows.length === 0) return `No logins recorded for ${account.name}.`;
      const when = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
      const lines = [`Recent logins for ${account.name}:`, ...rows.map((r) => `  ${when(r.ts)} UTC  ${r.character}  ${r.ip}`)];
      const alts = ctx.logins.sharingIp(key);
      lines.push(alts.length ? 'Same address as:' : 'No other account seen on these addresses.');
      for (const a of alts) lines.push(`  ${a.account} (${a.ip})`);
      return lines.join('\n');
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
    usage: IPBAN_USAGE,
    help: 'ban the address of an online player, or a literal IP; a timed ban lifts itself',
    run(ctx, actor, args) {
      const who = arg(args, 0);
      const terms = banTerms(args);
      if (!who || !terms) return `usage: ${IPBAN_USAGE}`;
      const { reason, until } = terms;
      const target = ctx.roster.findByName(who);
      const ip = target?.ip ?? who;
      if (target && outranks(target.rank, target.name, actor)) return `${target.name} is not below your rank.`;
      if (!target && !looksLikeIp(who)) return `No online player named "${who}" and "${who}" is not an IP.`;
      ctx.bans.banIp(ip, actor.name, reason, until);
      for (const p of ctx.roster.inWorld()) if (p.ip === ip) p.peer.disconnect('BANNED', reason);
      audit(actor, 'ipban', { ip, target: target?.name, reason, until: until ? new Date(until).toISOString() : 'perm' });
      return `IP-banned ${ip}${forSpan(until)}: ${reason}`;
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

// OT3-187: `<who> [30m|12h|7d|perm] <reason>`. The reason is mandatory; no span = permanent.
// Parsed from the joined rest so the dashboard's one free-text field ("1d spamming") works too.
const SPAN_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const MAX_BAN_MS = 365 * 86_400_000;
export function banTerms(args: string[], now = Date.now()): { reason: string; until?: number } | undefined {
  const rest = args.slice(1).join(' ').trim();
  const m = /^(perm|(\d+)([mhd]))(?:\s+|$)/i.exec(rest);
  const reason = (m ? rest.slice(m[0].length) : rest).trim().slice(0, MAX_ARG);
  if (!reason) return undefined;
  if (!m || m[1]!.toLowerCase() === 'perm') return { reason };
  const ms = Number(m[2]) * SPAN_MS[m[3]!.toLowerCase()]!;
  if (!(ms > 0 && ms <= MAX_BAN_MS)) return undefined;
  return { reason, until: now + ms };
}
const forSpan = (until?: number): string =>
  until ? ` until ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';

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

  /** OT3-186: one login-history row per authed human session. Never throws. */
  recordLogin(p: Player): void {
    if (p.system === true || !p.ip) return;
    try {
      this.ctx.logins?.record(p.accountKey, p.name, p.ip);
    } catch (err) {
      log('error', 'admin.login_record_failed', { error: String(err) });
    }
  }

  // THE ONE GATE. Operator commands enter only through the dashboard (server.ts runCommand,
  // behind POST /admin/api/command); there is no typed or in-game route. Never throws: a
  // failure comes back as text the caller shows the actor.
  async exec(actor: Player, cmd: string, args: string[]): Promise<string> {
    const spec = ADMIN_COMMANDS[cmd];
    if (!spec) return `Unknown command /${cmd}.`;
    const row = (outcome: AuditRow['outcome'], result: string): string => {
      try {
        this.ctx.audit?.write({ ts: Date.now(), actor: actor.accountKey, actorName: actor.name, cmd,
          target: args[0] ?? '', args: args.join(' '), reason: args.slice(1).join(' '), outcome, result });
      } catch (err) {
        log('error', 'admin.audit_failed', { cmd, error: String(err) });
      }
      return result;
    };
    if (actor.rank < spec.minRank) {
      log('warn', 'admin.refused', { actor: actor.name, cmd, rank: actor.rank, need: spec.minRank });
      return row('refused', refusal(cmd, spec.minRank, actor.rank));
    }
    if (!this.ctx.allow(actor, cmd)) {
      log('warn', 'admin.vetoed', { actor: actor.name, cmd });
      return row('vetoed', `/${cmd} is not permitted for you on this server.`);
    }
    try {
      return row('ok', await spec.run(this.ctx, actor, args));
    } catch (err) {
      log('error', 'admin.failed', { actor: actor.name, cmd, error: String(err) });
      return row('failed', `/${cmd} failed: internal error.`);
    }
  }

}
