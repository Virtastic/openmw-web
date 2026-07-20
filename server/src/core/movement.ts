// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M1 movement relay: occupancy/visibility rules and the 66 ms PlayerMoveBatch tick.
// Visibility = same cellKey, or both exterior ("x,y" ints) with Chebyshev distance <= 1.
// A player with no cellKey yet is visible to nobody (the client sends PlayerCellChange
// right after Ready).

import type { Player, Roster } from './players';
import { MSG_PLAYER_MOVE_BATCH } from '../proto/envelope';
import { packMoveBatch, type BatchEntry } from '../proto/movement';

export const BATCH_INTERVAL_MS = 66;
export const MAX_ABS_COORD = 512000;

const EXTERIOR_RE = /^(-?\d+),(-?\d+)$/;

export function parseExterior(cellKey: string): { x: number; y: number } | null {
  const m = EXTERIOR_RE.exec(cellKey);
  return m ? { x: parseInt(m[1]!, 10), y: parseInt(m[2]!, 10) } : null;
}

export function cellsVisible(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (a === b) return true;
  const ea = parseExterior(a);
  const eb = parseExterior(b);
  if (!ea || !eb) return false;
  return Math.abs(ea.x - eb.x) <= 1 && Math.abs(ea.y - eb.y) <= 1;
}

// Per-recipient change tracking: known[senderId] = last poseVersion sent to that
// recipient. Unknown sender (join / just became visible) or a differing version means
// "include in this batch" — one mechanism covers both dirty-poses and
// force-include-on-visibility. Entries for senders no longer visible are dropped so
// re-entering visibility force-includes again.
export class MoveBroadcaster {
  private perRecipient = new Map<number, Map<number, number>>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly roster: Roster,
    private readonly intervalMs = BATCH_INTERVAL_MS,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  tick(): void {
    const inWorld = this.roster.inWorld();
    const liveIds = new Set(inWorld.map((p) => p.id));
    // Drop state for recipients that left.
    for (const id of this.perRecipient.keys()) if (!liveIds.has(id)) this.perRecipient.delete(id);

    for (const recipient of inWorld) {
      let known = this.perRecipient.get(recipient.id);
      if (!known) {
        known = new Map();
        this.perRecipient.set(recipient.id, known);
      }
      const visibleIds = new Set<number>();
      const entries: BatchEntry[] = [];
      for (const sender of inWorld) {
        if (sender.id === recipient.id) continue;
        if (!cellsVisible(recipient.cellKey, sender.cellKey)) continue;
        visibleIds.add(sender.id);
        if (!sender.pose) continue; // nothing to relay yet
        if (known.get(sender.id) === sender.poseVersion) continue; // unchanged since last batch
        if (entries.length < 255) {
          entries.push({ id: sender.id, pose: sender.pose });
          known.set(sender.id, sender.poseVersion);
        }
      }
      // Forget senders that left visibility so their return force-includes.
      for (const id of known.keys()) if (!visibleIds.has(id)) known.delete(id);
      if (entries.length > 0) recipient.peer.sendBinary(MSG_PLAYER_MOVE_BATCH, packMoveBatch(entries));
    }
  }
}
