// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// ChatSend -> ChatMessage broadcast; "/"-prefixed text routes to the command registry.

import type { LValue } from '../proto/lser';
import type { Player, Roster } from './players';
import type { CommandRegistry, CommandContext } from './commands';
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

export function handleChatSend(
  ctx: CommandContext,
  commands: CommandRegistry,
  hooks: ChatHooks,
  player: Player,
  body: LValue | undefined,
): void {
  const text = body instanceof Map ? body.get('text') : undefined;
  if (typeof text !== 'string' || text.length === 0) {
    log('warn', 'chat.bad_body', { from: player.name });
    return;
  }
  const trimmed = text.slice(0, MAX_CHAT_CHARS);
  if (trimmed.startsWith('/')) {
    commands.dispatch(ctx, player, trimmed);
    return;
  }
  if (!hooks.onChat(player, trimmed)) return;
  broadcastChat(ctx.roster, { channel: 'say', from: player.name, fromId: player.id, text: trimmed });
  log('info', 'chat.say', { from: player.name, chars: trimmed.length });
}
