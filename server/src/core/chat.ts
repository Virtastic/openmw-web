// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// ChatSend -> ChatMessage broadcast; "/"-prefixed text routes to the command registry.

import type { LValue } from '../proto/lser';
import type { Player, Roster } from './players';
import type { CommandRegistry, CommandContext } from './commands';
import type { Moderation } from './moderation';
import { cellsVisible } from './movement';
import { log } from '../log';

export const MAX_CHAT_CHARS = 1024;

// Type alias (not interface) so it structurally satisfies JsLike's index signature.
export type ChatMessageBody = {
  // Phase 2.5 chat tiers:
  //   say     proximity — everyone whose interest bubble you are in (the default)
  //   party   WORLD chat ('@' tier): everyone in your world. The wire name predates the
  //           party removal; the semantics are per-world.
  //   global  the whole world, rate-limited
  //   server  announcements; never muted, never proximity-filtered
  //   whisper one recipient
  channel: 'say' | 'party' | 'global' | 'server' | 'whisper';
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

export interface ChatHooks {
  // false = a plugin vetoed the line.
  onChat(player: Player, text: string): boolean;
  /** Record a line for SCROLLBACK (distinct from the moderation log, which is an archive
   *  answering a different question). Absent = no history kept. */
  history?(player: Player, channel: string, text: string): void;
}

// A4: the durable moderation stream. Slash commands are recorded too (channel 'command')
// because "what did they type right before they got kicked" is exactly the question an
// operator asks — but the text is NOT broadcast, so it never reaches another player.
export function recordChat(mod: Moderation | undefined, player: Player, channel: string, text: string): void {
  mod?.chat.record({
    ts: new Date().toISOString(),
    playerId: player.id,
    account: player.accountKey,
    name: player.name,
    channel,
    text,
  });
}

// Whisper: a directed line to exactly one recipient (chosen from the friend dropdown, so
// `to` is their account key). Delivered only if the recipient is co-resident in this world
// process — cross-world whisper waits on a platform relay that does not exist yet.
// The recipient's mute of the sender silently drops their copy, but
// the sender always gets their own echo so the UI never looks broken.
function deliverWhisper(
  ctx: CommandContext,
  player: Player,
  toAcct: string,
  line: string,
  mod?: Moderation,
): void {
  if (toAcct === '' || toAcct === player.accountKey) {
    serverWhisper(player, 'Pick someone to whisper.');
    return;
  }
  const target = ctx.roster.activeForAccount(toAcct);
  if (!target || !target.inWorld) {
    serverWhisper(player, 'That friend is not reachable from here.');
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
  ctx: CommandContext,
  commands: CommandRegistry,
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
  // The client's channel selector sends the chosen channel explicitly; a raw client (or a
  // typed prefix) still works via the !/@ fallback below. `to` is the whisper recipient's
  // ACCOUNT KEY (the friend dropdown carries accounts, never usernames — usernames change).
  const explicitChannel = body instanceof Map && typeof body.get('channel') === 'string'
    ? (body.get('channel') as string) : '';
  const whisperTo = body instanceof Map && typeof body.get('to') === 'string'
    ? (body.get('to') as string) : '';
  const trimmed = text.slice(0, MAX_CHAT_CHARS);
  if (trimmed.startsWith('/')) {
    // Record BEFORE dispatch: a command that disconnects the actor still leaves a trace.
    recordChat(mod, player, 'command', trimmed);
    commands.dispatch(ctx, player, trimmed);
    return;
  }
  if (!hooks.onChat(player, trimmed)) return; // vetoed lines were never delivered, so never logged
  // Channel resolution: an explicit channel from the selector wins; otherwise the !/@ MMO
  // prefixes. '/p' would collide with the command registry and "/party hi" should be a
  // message not a usage error, so tiers are parsed here rather than as slash commands.
  let channel: 'say' | 'party' | 'global' | 'whisper' = 'say';
  let line = trimmed;
  if (explicitChannel === 'say' || explicitChannel === 'party'
    || explicitChannel === 'global' || explicitChannel === 'whisper') {
    channel = explicitChannel;
  } else if (/^!/.test(trimmed)) {
    channel = 'global';
    line = trimmed.slice(1).trim();
  } else if (/^@/.test(trimmed)) {
    channel = 'party';
    line = trimmed.slice(1).trim();
  }
  if (line === '') return; // a bare prefix is a typo, not a message

  if (channel === 'whisper') {
    deliverWhisper(ctx, player, whisperTo, line, mod);
    return;
  }
  recordChat(mod, player, channel, line);
  const msg: ChatMessageBody = { channel, from: player.name, fromId: player.id, text: line };
  if (channel === 'party') {
    // WORLD chat: the people in your world are your group (ctx.partyOf returns exactly
    // them — see server.ts commandCtx). No membership list, no cross-world relay needed.
    const members = ctx.partyOf?.(player.accountKey) ?? [];
    if (members.length === 0) {
      serverWhisper(player, 'Nobody is here to hear you.');
      return;
    }
    for (const p of ctx.roster.inWorld()) {
      if (!members.includes(p.accountKey)) continue;
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
