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
  //   party   your group, wherever they are (realm-independent: it must survive a member
  //           hopping worlds mid-conversation, which is the whole point of party travel)
  //   global  the whole world, rate-limited
  //   server  announcements; never muted, never proximity-filtered
  //   whisper one recipient
  channel: 'say' | 'party' | 'global' | 'server' | 'whisper';
  from?: string;
  fromId?: number;
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
  const trimmed = text.slice(0, MAX_CHAT_CHARS);
  if (trimmed.startsWith('/')) {
    // Record BEFORE dispatch: a command that disconnects the actor still leaves a trace.
    recordChat(mod, player, 'command', trimmed);
    commands.dispatch(ctx, player, trimmed);
    return;
  }
  if (!hooks.onChat(player, trimmed)) return; // vetoed lines were never delivered, so never logged
  // Tier prefixes, mirroring how every MMO chat box works. Deliberately parsed here
  // rather than as slash commands: '/p' would collide with the command registry, and a
  // player typing '/party hello' expects a message, not a usage error.
  let channel: 'say' | 'party' | 'global' = 'say';
  let line = trimmed;
  if (/^!/.test(trimmed)) {
    channel = 'global';
    line = trimmed.slice(1).trim();
  } else if (/^@/.test(trimmed)) {
    channel = 'party';
    line = trimmed.slice(1).trim();
  }
  if (line === '') return; // a bare prefix is a typo, not a message

  recordChat(mod, player, channel, line);
  const msg: ChatMessageBody = { channel, from: player.name, fromId: player.id, text: line };
  if (channel === 'party') {
    const members = ctx.partyOf?.(player.accountKey) ?? [];
    if (members.length === 0) {
      serverWhisper(player, 'You are not in a party.');
      return;
    }
    // Realm-independent BY CONSTRUCTION only within this world process; a member in
    // another world receives it when the platform-level relay lands (their party
    // membership is already shared state). Here: everyone co-resident and in the party.
    for (const p of ctx.roster.inWorld()) {
      if (!members.includes(p.accountKey)) continue;
      if (p.accountKey !== player.accountKey && ctx.isMuted?.(p.accountKey, player.accountKey)) continue;
      p.peer.sendEvent('ChatMessage', msg);
    }
  } else if (channel === 'say' && ctx.sayProximity === true) {
    // PROXIMITY say — public worlds only. Shouting across the province is what makes a
    // crowded public chat box unreadable. In a private or party world the opposite is
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
  log('info', 'chat.' + channel, { from: player.name, chars: line.length });
}
