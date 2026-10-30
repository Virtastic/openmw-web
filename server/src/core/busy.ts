// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-105: the BUSY flag. A player in a menu or a dialogue is not playing the game: AI must
// not hunt them and others should see a marker. The client reports its UI mode edge
// (UiBusy{busy}); the server owns the clock: busy lasts at most BUSY_CAP_MS (a stuck window or a
// modified client cannot hide forever) and ends the moment the player takes damage. Every
// change is told to the world peer (PlayerBusy{id,busy}) so it can skip a busy avatar when it
// picks AI targets. The peer-side honouring is a separate C++ change (puppets.hpp / actors.cpp);
// until it lands the flag is state plus markers, which is the honest part we can ship.

import type { Player } from './players';
import type { LValue } from '../proto/lser';
import { log } from '../log';

export const BUSY_CAP_MS = 120_000;

export interface BusyDeps {
  now(): number;
  /** Told on every change (to the world peer). */
  notify(player: Player, busy: boolean): void;
}

export class BusyFlags {
  private readonly until = new Map<number, number>(); // playerId -> expiry ms

  constructor(private readonly d: BusyDeps) {}

  /** Event-tier entry: `UiBusy{busy:boolean}` from the owner. */
  handleEvent(p: Player, name: string, value: LValue | undefined): boolean {
    if (name !== 'UiBusy') return false;
    const busy = value instanceof Map ? value.get('busy') : undefined;
    if (typeof busy === 'boolean') this.set(p, busy);
    return true;
  }

  set(p: Player, busy: boolean): void {
    const had = this.until.has(p.id);
    if (busy) this.until.set(p.id, this.d.now() + BUSY_CAP_MS); // a repeat report renews the cap
    else this.until.delete(p.id);
    if (busy !== had) this.d.notify(p, busy);
  }

  isBusy(id: number): boolean {
    const t = this.until.get(id);
    return t !== undefined && this.d.now() < t;
  }

  /** Damage ends busy at once: whoever hurt you is not waiting for you to finish the menu. */
  damaged(p: Player): void {
    if (this.until.has(p.id)) {
      log('info', 'busy.cleared_by_damage', { player: p.name });
      this.set(p, false);
    }
  }

  /** The server cap; called from the 2 s tick. */
  sweep(byId: (id: number) => Player | undefined): void {
    const now = this.d.now();
    for (const [id, t] of this.until) {
      if (now < t) continue;
      const p = byId(id);
      this.until.delete(id);
      if (p) this.d.notify(p, false);
    }
  }

  forget(p: Player): void { this.until.delete(p.id); }
}
