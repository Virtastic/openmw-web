// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M4 actor-authority state machine (PROTOCOL.md §M4). One holder per cell simulates its
// NPCs/creatures; everyone else renders puppets off the wire. State per cell:
// {holderId, epoch, lastSnapshot, order}. `order` is the arrival sequence of current
// occupants — its front is the longest-present player, which is who inherits authority on
// handoff. Every transition here runs INSIDE WorldState's single op queue, so contested
// entry resolves first-processed-wins and epochs advance deterministically.
//
// Standalone (senders injected) so the fuzz test can drive it without a live server.

import type { JsLike } from '../proto/lser';

export type ActorSnapshot = JsLike; // { actors: [...] }, JSON-safe (never a Map)

export interface AuthoritySenders {
  grant(playerId: number, cellKey: string, epoch: number, snapshot: ActorSnapshot): void;
  revoke(playerId: number, cellKey: string, epoch: number): void; // to a holder leaving its cell
  info(playerId: number, cellKey: string, holderId: number): void; // to a non-holder entrant
  // Dormant cell state: persisted in the cell doc, handed to the next claimant.
  loadOverrides(cellKey: string): Promise<ActorSnapshot>;
  foldOverrides(cellKey: string, snapshot: ActorSnapshot): Promise<void>;
}

interface Cell {
  holderId: number | null;
  epoch: number; // only ever increments (monotonic per cell), even across dormancy
  lastSnapshot: ActorSnapshot | null;
  order: number[]; // arrival order of current occupants; front = longest-present
}

const EMPTY_SNAPSHOT: ActorSnapshot = { actors: [] };

export class Authority {
  private cells = new Map<string, Cell>();

  constructor(private readonly send: AuthoritySenders) {}

  holderOf(cellKey: string): number | undefined {
    return this.cells.get(cellKey)?.holderId ?? undefined;
  }

  currentEpoch(cellKey: string): number | undefined {
    const c = this.cells.get(cellKey);
    return c && c.holderId !== null ? c.epoch : undefined; // no live epoch while dormant
  }

  occupants(cellKey: string): number[] {
    return [...(this.cells.get(cellKey)?.order ?? [])];
  }

  // Holder-only, epoch-current snapshot store (callers validate before invoking).
  setSnapshot(cellKey: string, snapshot: ActorSnapshot): void {
    const c = this.cells.get(cellKey);
    if (c) c.lastSnapshot = snapshot;
  }

  private cell(cellKey: string): Cell {
    let c = this.cells.get(cellKey);
    if (!c) {
      c = { holderId: null, epoch: 0, lastSnapshot: null, order: [] };
      this.cells.set(cellKey, c);
    }
    return c;
  }

  // A player's PlayerCellChange landed them in cellKey.
  async onEnter(playerId: number, cellKey: string): Promise<void> {
    const c = this.cell(cellKey);
    if (!c.order.includes(playerId)) c.order.push(playerId);
    if (c.holderId === null) {
      // Fresh claim of a dormant/new cell: snapshot = in-memory last, else the doc
      // overrides (survives restart), else empty.
      const snapshot = c.lastSnapshot ?? (await this.loadOr(cellKey));
      c.holderId = playerId;
      c.epoch += 1;
      this.send.grant(playerId, cellKey, c.epoch, snapshot);
      for (const other of c.order) if (other !== playerId) this.send.info(other, cellKey, playerId);
    } else if (c.holderId !== playerId) {
      this.send.info(playerId, cellKey, c.holderId);
    }
  }

  // A player left cellKey (cell change out, or disconnect). `connected` reports whether
  // the leaver is still on the server (false on disconnect → no Revoke to a dead socket).
  async onLeave(playerId: number, cellKey: string, connected: boolean): Promise<void> {
    const c = this.cells.get(cellKey);
    if (!c) return;
    c.order = c.order.filter((id) => id !== playerId);
    if (c.holderId !== playerId) return; // a non-holder left; occupancy shrank, holder stands
    if (connected) this.send.revoke(playerId, cellKey, c.epoch);
    if (c.order.length > 0) {
      const next = c.order[0]!; // longest-present remaining
      c.holderId = next;
      c.epoch += 1;
      this.send.grant(next, cellKey, c.epoch, c.lastSnapshot ?? EMPTY_SNAPSHOT);
    } else {
      // Empty cell: fold the snapshot into the doc and go dormant (epoch retained).
      await this.send.foldOverrides(cellKey, c.lastSnapshot ?? EMPTY_SNAPSHOT);
      c.holderId = null;
    }
  }

  private async loadOr(cellKey: string): Promise<ActorSnapshot> {
    const overrides = await this.send.loadOverrides(cellKey);
    return overrides ?? EMPTY_SNAPSHOT;
  }
}
