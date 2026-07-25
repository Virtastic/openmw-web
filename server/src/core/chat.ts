// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// ChatSend -> ChatMessage broadcast; "/"-prefixed text routes to the command registry.

import type { LValue } from '../proto/lser';
import type { Player, Roster } from './players';
import type { CommandRegistry, CommandContext } from './commands';
import type { Moderation } from './moderation';
import { log } from '../log';

export const MAX_CHAT_CHARS = 1024;

// Type alias (not interface) so it structurally satisfies JsLike's index signature.
export type ChatMessageBody = {
  channel: 'say' | 'server' | 'whisper';
  from?: string;
  fromId?: number;
  text: string;
};

export function broadcastChat(roster: Roster, msg: ChatMessageBody): void {
  for (const p of roster.inWorld()) p.peer.sendEvent('ChatMessage', msg);
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
  recordChat(mod, player, 'say', trimmed);
  broadcastChat(ctx.roster, { channel: 'say', from: player.name, fromId: player.id, text: trimmed });
  log('info', 'chat.say', { from: player.name, chars: trimmed.length });
}
