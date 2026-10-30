// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// ChatSend -> ChatMessage broadcast. The channel is explicit on the wire; a "/" line is plain chat.

import type { LValue } from '../proto/lser';
import type { Player, Roster } from './players';
import type { Moderation } from './moderation';

/** What chat delivery needs to know about the world it runs in. */
export interface ChatContext {
  roster: Roster;
  /** Record a delivered line for SCROLLBACK. Optional so a partial context in a test still
   *  constructs, and absent simply means no history is kept. */
  history?(player: Player, channel: string, text: string): void;
  // Phase 2.5: mute lookup for chat delivery (see broadcastChat). Optional so a partial
  // context in a test still constructs.
  isMuted?(listenerAcct: string, speakerAcct: string): boolean;
  // World chat tier ('@'): the accountKeys of everyone in this player's world.
  worldOf?(accountKey: string): string[];
  // OT3-110: party chat. The accountKeys of this player's party (empty when unpartied).
  partyMembers?(accountKey: string): string[];
  // Phase 2.5: is plain 'say' proximity-scoped in THIS world? True for public worlds.
  sayProximity?: boolean;
  // OT3-23: accountKey -> when it last spoke on global. Per server, created on first use.
  lastGlobalAt?: Map<string, number>;
  globalCooldownMs?: number;
  // OT3-67: may this player read and post on the Novice channel? Absent = nobody may.
  noviceOk?(player: Player): boolean;
  // OT3-185: the public-channel filter (makeChatFilter). Absent = no filtering.
  filter?(line: string): string;
}

// OT3-185: mask listed words (whole words, any case) and links on PUBLIC channels. Party and
// whisper lines are between people who chose each other and go through untouched. The
// moderation log keeps the raw line: evidence is what was typed, not what was shown.
// ponytail: a fixed TLD list for bare domains; a link on an unlisted TLD without www./http
// gets through. Widen the list if spam finds the gap.
const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|gg|io|xyz|ru|cn|tk|ly)\b(?:\/\S*)?/gi;
export function makeChatFilter(words: readonly string[], links: boolean): ((line: string) => string) | undefined {
  const esc = words.map((w) => w.trim()).filter((w) => w !== '').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (esc.length === 0 && !links) return undefined;
  const word = esc.length > 0 ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${esc.join('|')})(?![\\p{L}\\p{N}])`, 'giu') : undefined;
  const mask = (m: string): string => '*'.repeat(m.length);
  return (line) => {
    let out = word ? line.replace(word, mask) : line;
    if (links) out = out.replace(LINK, mask);
    return out;
  };
}

// OT3-67 NOVICE channel: new characters (below NOVICE_MAX_LEVEL) and opted-in mentors only,
// so a sprout's question is not lost in world chat. A mentor must be at least
// MENTOR_MIN_LEVEL to opt in; staff can revoke (admin.ts /mentor).
export const NOVICE_MAX_LEVEL = 5;
export const MENTOR_MIN_LEVEL = 10;
export function noviceEligible(level: number, mentorState: string | undefined): boolean {
  return level < NOVICE_MAX_LEVEL || mentorState === 'on';
}
import { cellsVisible } from './movement';
import { log } from '../log';

const MAX_CHAT_CHARS = 1024;
// GLOBAL reaches every player on the server, so it is held to a tighter budget than say or
// world chat (OT3-23): a shorter line, one line per account per cooldown -- keyed on the
// ACCOUNT, so reconnecting does not reset it -- and nothing at all while on probation.
const MAX_GLOBAL_CHARS = 256;

// Returns the refusal to whisper back, or null when the line may go out.
function globalRefusal(lastGlobalAt: Map<string, number>, cooldownMs: number, player: Player, now: number): string | null {
  if ((player.probationUntil ?? 0) > now) return 'New accounts cannot use global chat for their first day.';
  const last = lastGlobalAt.get(player.accountKey) ?? 0;
  if (now - last < cooldownMs) {
    return `Global chat: wait ${Math.ceil((cooldownMs - (now - last)) / 1000)} s before the next line.`;
  }
  // ponytail: one entry per account that ever spoke globally; prune when it passes 10k.
  if (lastGlobalAt.size > 10_000) {
    for (const [k, t] of lastGlobalAt) if (now - t >= cooldownMs) lastGlobalAt.delete(k);
  }
  lastGlobalAt.set(player.accountKey, now);
  return null;
}

// Type alias (not interface) so it structurally satisfies JsLike's index signature.
export type ChatMessageBody = {
  // Phase 2.5 chat tiers:
  //   say     proximity — everyone whose interest bubble you are in (the default)
  //   world   WORLD chat: everyone in your world (OT3-110: was 'party' on the wire)
  //   party   your party (OT3-106), and only them
  //   global  the whole world, rate-limited
  //   server  announcements; never muted, never proximity-filtered
  //   whisper one recipient
  //   novice  new characters + mentors (OT3-67)
  channel: 'say' | 'world' | 'party' | 'global' | 'server' | 'whisper' | 'novice';
  from?: string;
  fromId?: number;
  // Whisper only: on the SENDER's echo copy, the recipient's display name, so the client can
  // render "-> Name: text" instead of "Name: text". Absent on the recipient's copy.
  to?: string;
  text: string;
};

// isMuted: Phase 3.8/2.5 — a listener who muted the speaker (or a moderator mute, which
// is the same list under a server pseudo-muter) simply never receives the line. Enforced
// HERE rather than client-side because a mute a modified client can ignore is not a mute.
// Server lines (channel 'server') are never suppressed: they are announcements, not a
// player talking.
export function broadcastChat(
  roster: Roster,
  msg: ChatMessageBody,
  isMuted?: (listenerAcct: string, speakerAcct: string) => boolean,
  speakerAcct?: string,
): void {
  for (const p of roster.inWorld()) {
    if (isMuted && speakerAcct !== undefined && p.accountKey !== speakerAcct
      && isMuted(p.accountKey, speakerAcct)) continue;
    p.peer.sendEvent('ChatMessage', msg);
  }
}

export function serverWhisper(player: Player, text: string): void {
  player.peer.sendEvent('ChatMessage', { channel: 'server', text } satisfies ChatMessageBody);
}

interface ChatHooks {
  // false = a plugin vetoed the line.
  onChat(player: Player, text: string): boolean;
  /** Record a line for SCROLLBACK (distinct from the moderation log, which is an archive
   *  answering a different question). Absent = no history kept. */
  history?(player: Player, channel: string, text: string): void;
}

// A4: the durable moderation stream. Slash commands are recorded too (channel 'command')
// because "what did they type right before they got kicked" is exactly the question an
// operator asks — but the text is NOT broadcast, so it never reaches another player.
function recordChat(mod: Moderation | undefined, player: Player, channel: string, text: string): void {
  mod?.chat.record({
    ts: new Date().toISOString(),
    playerId: player.id,
    account: player.accountKey,
    name: player.name,
    channel,
    text,
  });
}

// Whisper: a directed line to exactly one recipient. `to` is an account key or (OT3-134)
// the name typed in the whisper box, any case. Delivered only if the recipient is in this
// world process — cross-world whisper waits on a platform relay that does not exist yet.
// A mute or a block either way (isMuted covers both) silently drops the recipient's copy,
// but the sender always gets their own echo so a block is not revealed.
function deliverWhisper(
  ctx: ChatContext,
  player: Player,
  toAcct: string,
  line: string,
  mod?: Moderation,
): void {
  if (toAcct === '' || toAcct === player.accountKey) {
    serverWhisper(player, 'Pick someone to whisper.');
    return;
  }
  const target = ctx.roster.activeForAccount(toAcct) ?? ctx.roster.findByName(toAcct);
  if (target === player) {
    serverWhisper(player, 'Pick someone to whisper.');
    return;
  }
  if (!target || !target.inWorld) {
    serverWhisper(player, `Nobody called ${toAcct} is online here.`);
    return;
  }
  recordChat(mod, player, 'whisper', line);
  const muted = ctx.isMuted?.(target.accountKey, player.accountKey) === true;
  if (!muted) {
    target.peer.sendEvent('ChatMessage', {
      channel: 'whisper', from: player.name, fromId: player.id, text: line,
    } satisfies ChatMessageBody);
  }
  // Sender's echo carries `to` so the client renders it as an outgoing whisper.
  player.peer.sendEvent('ChatMessage', {
    channel: 'whisper', from: player.name, fromId: player.id, to: target.name, text: line,
  } satisfies ChatMessageBody);
  log('info', 'chat.whisper', { from: player.name, to: target.name, chars: line.length });
}

export function handleChatSend(
  ctx: ChatContext,
  hooks: ChatHooks,
  player: Player,
  body: LValue | undefined,
  mod?: Moderation,
): void {
  const text = body instanceof Map ? body.get('text') : undefined;
  if (typeof text !== 'string' || text.length === 0) {
    log('warn', 'chat.bad_body', { from: player.name });
    return;
  }
  // The client's channel selector sends the chosen channel explicitly; a missing or unknown
  // channel is plain 'say'. There are no typed !/@ prefixes. `to` is the whisper recipient's
  // ACCOUNT KEY (the friend dropdown carries accounts, never usernames — usernames change).
  const explicitChannel = body instanceof Map && typeof body.get('channel') === 'string'
    ? (body.get('channel') as string) : '';
  const whisperTo = body instanceof Map && typeof body.get('to') === 'string'
    ? (body.get('to') as string) : '';
  const trimmed = text.slice(0, MAX_CHAT_CHARS);
  // NO SLASH COMMANDS. A line starting with "/" is chat like any other line -- there is no
  // typed command path any more. Operators act from the dashboard (one gate, Admin.exec, an
  // audit line per action); players report, mute, block and set their privacy from the
  // social panel, which the server hears as SocialAction events. A second, typed route to
  // the same actions was a second place for the permission check to be wrong.
  if (!hooks.onChat(player, trimmed)) return; // vetoed lines were never delivered, so never logged
  // Channel resolution: the explicit channel from the selector, else 'say'.
  let channel: 'say' | 'world' | 'party' | 'global' | 'whisper' | 'novice' = 'say';
  let line = trimmed.trim();
  if (explicitChannel === 'say' || explicitChannel === 'world' || explicitChannel === 'party'
    || explicitChannel === 'global' || explicitChannel === 'whisper' || explicitChannel === 'novice') {
    channel = explicitChannel;
  }
  if (line === '') return; // a blank line is not a message
  if (channel === 'global') {
    const refused = globalRefusal(ctx.lastGlobalAt ??= new Map(), ctx.globalCooldownMs ?? 0, player, Date.now());
    if (refused !== null) {
      serverWhisper(player, refused);
      log('info', 'chat.global_refused', { from: player.name });
      return;
    }
    line = line.slice(0, MAX_GLOBAL_CHARS);
  }

  if (channel === 'whisper') {
    deliverWhisper(ctx, player, whisperTo, line, mod);
    return;
  }
  if (channel === 'novice' && ctx.noviceOk?.(player) !== true) {
    serverWhisper(player, `The Novice channel is for characters below level ${NOVICE_MAX_LEVEL} and mentors.`);
    return;
  }
  // OT3-110: 'party' means the party now. A client from before the rename sends its world
  // chat as 'party'; unpartied, it is told so rather than its line reaching a group it is not in.
  const members = channel === 'world' ? ctx.worldOf?.(player.accountKey) ?? []
    : channel === 'party' ? ctx.partyMembers?.(player.accountKey) ?? [] : [];
  if (channel === 'party' && members.length === 0) {
    serverWhisper(player, 'You are not in a party.');
    return;
  }
  recordChat(mod, player, channel, line);
  if (channel !== 'party' && ctx.filter) {
    const shown = ctx.filter(line);
    if (shown !== line) {
      log('info', 'chat.filtered', { from: player.name, account: player.accountKey, channel });
      line = shown;
    }
  }
  const msg: ChatMessageBody = { channel, from: player.name, fromId: player.id, text: line };
  if (channel === 'world' || channel === 'party') {
    // WORLD: the people in your world (server.ts commandCtx). PARTY: its members.
    if (members.length === 0) {
      serverWhisper(player, 'Nobody is here to hear you.');
      return;
    }
    // OT3-124: one pass with a Set; includes() per recipient was O(N^2) on world chat.
    const audience = new Set(members);
    for (const p of ctx.roster.inWorld()) {
      if (!audience.has(p.accountKey)) continue;
      if (p.accountKey !== player.accountKey && ctx.isMuted?.(p.accountKey, player.accountKey)) continue;
      p.peer.sendEvent('ChatMessage', msg);
    }
  } else if (channel === 'novice') {
    for (const p of ctx.roster.inWorld()) {
      if (ctx.noviceOk?.(p) !== true) continue;
      if (p.accountKey !== player.accountKey && ctx.isMuted?.(p.accountKey, player.accountKey)) continue;
      p.peer.sendEvent('ChatMessage', msg);
    }
  } else if (channel === 'say' && ctx.sayProximity === true) {
    // PROXIMITY say — opt-in per deployment. Shouting across the province is what makes a
    // crowded chat box unreadable. In a private or party world the opposite is
    // true: four friends spread across Vvardenfell must be able to talk, so 'say' stays
    // world-wide there and this scope follows the world's nature rather than a global
    // preference (see [rules].sayScope).
    for (const p of ctx.roster.inWorld()) {
      if (p.accountKey !== player.accountKey && ctx.isMuted?.(p.accountKey, player.accountKey)) continue;
      if (p.id !== player.id && !cellsVisible(p.cellKey, player.cellKey)) continue;
      p.peer.sendEvent('ChatMessage', msg);
    }
  } else {
    broadcastChat(ctx.roster, msg, ctx.isMuted, player.accountKey);
  }
  // Scrollback, after delivery: a line nobody received is not part of the conversation.
  ctx.history?.(player, channel, line);
  log('info', 'chat.' + channel, { from: player.name, chars: line.length });
}
