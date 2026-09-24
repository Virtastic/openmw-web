// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M8 session resume. A browser tab that reloads, a flaky wifi hop or a WebSocket idle
// timeout should not cost a player a full argon2id login and a chargen-check round trip.
// When an IN_WORLD session tears down, its sessionToken is parked here with the state
// needed to put the player back where they were; `SessionResume {token}` inside
// [login] resumeWindowSec skips auth and rejoins in place.
//
// IN-MEMORY, except across a GRACEFUL restart (save/load below): a crash still invalidates
// every session, but an update's rolling restart hands the parked tickets to the next
// process so connected players resume instead of being thrown out. Tokens are single-use —
// a resumed session mints a fresh one — so a stolen token cannot be replayed after the owner
// has used it, and never survives past the window it was minted with.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { PlayerPose } from '../proto/movement';

export interface ResumeTicket {
  accountKey: string;
  accountName: string;
  // Character slots: resume goes back to the SAME character the session was playing —
  // never the default — or a reload mid-adventure would swap the player onto whichever
  // character was last played somewhere else.
  charId?: string;
  cellKey?: string;
  pose?: PlayerPose;
  expiresAt: number;
}

export class ResumeStore {
  private tickets = new Map<string, ResumeTicket>();

  constructor(private readonly windowSec: number) {}

  get enabled(): boolean {
    return this.windowSec > 0;
  }

  size(): number {
    this.sweep();
    return this.tickets.size;
  }

  park(token: string, ticket: Omit<ResumeTicket, 'expiresAt'>): void {
    if (!this.enabled || !token) return;
    this.sweep();
    this.tickets.set(token, { ...ticket, expiresAt: Date.now() + this.windowSec * 1000 });
  }

  // Single use: a successful claim removes the ticket.
  claim(token: string): ResumeTicket | undefined {
    this.sweep();
    const ticket = this.tickets.get(token);
    if (!ticket) return undefined;
    this.tickets.delete(token);
    return ticket;
  }

  // Account deleted / banned: drop any parked ticket so it cannot be used to get back in.
  revokeAccount(accountKey: string): void {
    for (const [token, ticket] of [...this.tickets]) {
      if (ticket.accountKey === accountKey) this.tickets.delete(token);
    }
  }

  // The character authenticated afresh elsewhere: a ticket parked by its old tab would
  // otherwise resume later and supersede the new session (backlog 408). Per character, not
  // account -- #124 allows two characters per account.
  revokeChar(charId: string): void {
    for (const [token, ticket] of [...this.tickets]) {
      if (ticket.charId === charId) this.tickets.delete(token);
    }
  }

  clear(): void {
    this.tickets.clear();
  }

  // ACROSS A GRACEFUL RESTART (s175, #149). A rolling restart -- how an update is applied --
  // shut every world, and every connected player came back to "resume token expired or
  // unknown", then a spent login ticket, and either a full page reboot or (a guest) no way
  // back at all. The tickets parked by that shutdown's own disconnects are handed to the
  // next process instead: still single-use, still bound to the character, still inside the
  // window they were minted with. A crash writes nothing, so it still invalidates everything.
  save(path: string): number {
    this.sweep();
    const live = [...this.tickets];
    if (live.length === 0) return 0;
    writeFileSync(path, JSON.stringify(live), { mode: 0o600 });
    return live.length;
  }

  // Read once and delete: a file left behind must not be replayable by a later boot.
  load(path: string): number {
    if (!this.enabled || !existsSync(path)) return 0;
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { raw = null; }
    try { unlinkSync(path); } catch { /* already gone */ }
    if (!Array.isArray(raw)) return 0;
    const now = Date.now();
    let n = 0;
    for (const e of raw) {
      if (!Array.isArray(e) || typeof e[0] !== 'string' || !e[1] || typeof e[1] !== 'object') continue;
      const t = e[1] as ResumeTicket;
      if (typeof t.accountKey !== 'string' || typeof t.expiresAt !== 'number' || t.expiresAt <= now) continue;
      this.tickets.set(e[0], t);
      n++;
    }
    return n;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, ticket] of [...this.tickets]) if (ticket.expiresAt <= now) this.tickets.delete(token);
  }
}
