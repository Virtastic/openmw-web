// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M7 server-pushed GUI (PROTOCOL.md §M7). Plugins push a MessageBox / InputDialog /
// ListBox at a player and await the answer: every push returns a Promise that settles on
// the matching GuiReply.
//
// Three ways a pending dialog must die, all of which settle the promise exactly once —
// a leaked pending promise is a slow memory leak AND a stuck plugin:
//   reply      -> {answered:true, data}
//   timeout    -> {answered:false, reason:'timeout'}   (guiTimeoutSec)
//   disconnect -> {answered:false, reason:'disconnect'} (all of that player's dialogs)
// guiIds are server-issued and monotonic, so a late reply to an already-settled dialog
// can never resolve a NEWER one.

import type { LTable, LValue, JsLike } from '../proto/lser';
import type { Player, Roster } from './players';
import { log } from '../log';

const MAX_TEXT = 4096;
const MAX_LABEL = 256;
const MAX_ITEMS = 128;
const MAX_ITEM = 256;

export type GuiKind = 'GuiMessageBox' | 'GuiInputDialog' | 'GuiListBox';

export interface GuiResult {
  answered: boolean;
  data?: JsLike; // the client's reply payload (button index, text, item index, ...)
  reason?: 'timeout' | 'disconnect' | 'offline';
}

interface Pending {
  playerId: number;
  settle(result: GuiResult): void;
  timer: NodeJS.Timeout;
}

function cap(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length <= max ? v : undefined;
}

export class GuiRouter {
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(
    private readonly roster: Roster,
    private readonly timeoutMs: number,
  ) {}

  // Tests/ops: dialogs still waiting for an answer. Must reach 0 after teardown.
  pendingCount(): number {
    return this.pending.size;
  }

  private settle(guiId: number, result: GuiResult): void {
    const entry = this.pending.get(guiId);
    if (!entry) return; // already settled: late reply, or a double reply
    this.pending.delete(guiId);
    clearTimeout(entry.timer);
    entry.settle(result);
  }

  private push(playerId: number, kind: GuiKind, body: Record<string, JsLike>): Promise<GuiResult> {
    const player = this.roster.get(playerId);
    if (!player || !player.inWorld) return Promise.resolve({ answered: false, reason: 'offline' });
    const guiId = this.nextId++;
    return new Promise<GuiResult>((resolve) => {
      const timer = setTimeout(() => {
        log('debug', 'gui.timeout', { guiId, playerId, kind });
        this.settle(guiId, { answered: false, reason: 'timeout' });
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(guiId, { playerId, settle: resolve, timer });
      player.peer.sendEvent(kind, { guiId, ...body });
    });
  }

  messageBox(playerId: number, text: string, buttons: string[] = []): Promise<GuiResult> {
    return this.push(playerId, 'GuiMessageBox', {
      text: cap(text, MAX_TEXT) ?? '',
      buttons: buttons.slice(0, MAX_ITEMS).map((b) => cap(b, MAX_ITEM) ?? ''),
    });
  }

  inputDialog(playerId: number, label: string): Promise<GuiResult> {
    return this.push(playerId, 'GuiInputDialog', { label: cap(label, MAX_LABEL) ?? '' });
  }

  listBox(playerId: number, label: string, items: string[]): Promise<GuiResult> {
    return this.push(playerId, 'GuiListBox', {
      label: cap(label, MAX_LABEL) ?? '',
      items: items.slice(0, MAX_ITEMS).map((i) => cap(i, MAX_ITEM) ?? ''),
    });
  }

  // C->S GuiReply {guiId, data}. A reply for someone else's dialog is dropped, not
  // honoured: guiIds are guessable, and a player must not answer another's prompt.
  handleReply(player: Player, body: LTable): void {
    const guiId = body.get('guiId');
    if (typeof guiId !== 'number' || !Number.isInteger(guiId) || guiId <= 0) {
      log('warn', 'gui.bad_reply', { from: player.name });
      return;
    }
    const entry = this.pending.get(guiId);
    if (!entry) return; // timed out or already answered
    if (entry.playerId !== player.id) {
      log('warn', 'gui.reply_wrong_player', { from: player.name, guiId });
      return;
    }
    const data = body.get('data') as LValue | undefined;
    this.settle(guiId, { answered: true, data: toJs(data) });
  }

  // Disconnect: settle every dialog this player owed an answer for.
  onDisconnect(playerId: number): void {
    for (const [guiId, entry] of [...this.pending]) {
      if (entry.playerId === playerId) this.settle(guiId, { answered: false, reason: 'disconnect' });
    }
  }

  // Shutdown: nothing may stay pending across a server stop.
  closeAll(): void {
    for (const guiId of [...this.pending.keys()]) this.settle(guiId, { answered: false, reason: 'disconnect' });
  }
}

// GuiReply.data is plugin-defined; pass through scalars and shallow-convert tables.
function toJs(v: LValue | undefined): JsLike {
  if (v === undefined) return null;
  if (v instanceof Map) {
    const out: Record<string, JsLike> = {};
    for (const [k, val] of v) if (typeof k === 'string' || typeof k === 'number') out[String(k)] = toJs(val);
    return out;
  }
  return v as JsLike;
}
