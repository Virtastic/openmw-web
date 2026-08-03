// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M8 session resume. A browser tab that reloads, a flaky wifi hop or a WebSocket idle
// timeout should not cost a player a full argon2id login and a chargen-check round trip.
// When an IN_WORLD session tears down, its sessionToken is parked here with the state
// needed to put the player back where they were; `SessionResume {token}` inside
// [login] resumeWindowSec skips auth and rejoins in place.
//
// Deliberately IN-MEMORY: a resume ticket is a live-server credential, and a restart
// legitimately invalidates every session (the world is re-seeded, authority is re-claimed).
// Tokens are single-use — a resumed session mints a fresh one — so a stolen token cannot
// be replayed after the owner has used it, and never survives past the window.

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

  clear(): void {
    this.tickets.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, ticket] of [...this.tickets]) if (ticket.expiresAt <= now) this.tickets.delete(token);
  }
}
