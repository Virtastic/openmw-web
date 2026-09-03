// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Actor authority (PROTOCOL.md §M4). One holder per cell simulates its NPCs/creatures;
// everyone else renders puppets off the wire. State per cell: {holderId, epoch,
// lastSnapshot, order}, where `order` is the arrival sequence of current occupants. Every
// transition driven from WorldState runs INSIDE its single op queue, so contested entry
// resolves first-processed-wins and epochs advance deterministically.
//
// THE ONLY ELIGIBLE HOLDER IS THE SIM PEER. Not "preferred", not "elected first" — the sole
// candidate, in every deployment. A player's browser never simulates NPCs for anyone else,
// so a modified client cannot author actor state, and there is no fitness contest to rig.
//
// This replaced an election between competing CLIENTS scored on server-measured RTT and
// shed rate, with anti-flap damping and handoffs. All of that only had meaning while several
// clients could hold a cell. With exactly one eligible holder there is nothing to rank,
// nothing to hand off to, and nothing to damp: the peer holds every cell it occupies, and a
// cell the peer has not reached simply waits for it rather than falling back to a player.
//
// Standalone (senders injected) so the fuzz test can drive it without a live server.

import type { JsLike } from '../proto/lser';
import { log } from '../log';
import { metrics } from '../metrics';

export type ActorSnapshot = JsLike; // { actors: [...] }, JSON-safe (never a Map)

export interface AuthoritySenders {
  grant(playerId: number, cellKey: string, epoch: number, snapshot: ActorSnapshot): void;
  revoke(playerId: number, cellKey: string, epoch: number): void; // to a holder leaving its cell
  // To a non-holder: on entry, and again whenever the epoch changes (handoff), so every
  // client in a cell always knows the live epoch — non-holders need it to address actors
  // (M5 combat) and to recognise stale traffic.
  info(playerId: number, cellKey: string, holderId: number | undefined, epoch: number): void;
  // Dormant cell state: persisted in the cell doc, handed to the next claimant.
  loadOverrides(cellKey: string): Promise<ActorSnapshot>;
  foldOverrides(cellKey: string, snapshot: ActorSnapshot): Promise<void>;
}

// ------------------------------------------------------------------- tuning

export interface AuthorityTuning {
  reviewMs: number; // 0 disables the periodic liveness sweep
  // The sim peer has produced no ActorMoveBatch for this long: the cell it holds is not being
  // simulated. There is nobody to hand it to (only the peer may hold), so this is reported,
  // not re-elected — a silent peer is an operator problem, and pretending otherwise by
  // shuffling the cell to a player is exactly the client-authority model that was removed.
  actorSilenceMs: number;
}

// Live, mutable: WorldState builds its Authority in its own constructor and never sees the
// config, so server.ts pushes operator tuning here (order-independent — values are read at
// use time, not captured).
export const authorityTuning: AuthorityTuning = {
  reviewMs: 10_000,
  // Comfortably longer than a stalled frame or a cell load, short enough that nobody plays
  // for long beside frozen NPCs. The grace clock starts at the GRANT, so a peer that has just
  // taken the cell is never judged before it could have produced anything.
  actorSilenceMs: 15_000,
};

export function configureAuthority(t: Partial<AuthorityTuning>): void {
  for (const [k, v] of Object.entries(t)) {
    // Warn+drop rather than throw: a bad tuning value must not take the server down, and
    // the shipped default is always a safe answer.
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      log('warn', 'authority.bad_tuning', { key: k, value: String(v) });
      continue;
    }
    (authorityTuning as unknown as Record<string, number>)[k] = v;
  }
}

// Can this connection simulate a cell's actors? ONLY the sim peer can. Injected so Authority
// stays standalone for the fuzz test.
export interface CapabilitySource {
  canSimulate(playerId: number): boolean;
}

const EMPTY_SNAPSHOT: ActorSnapshot = { actors: [] };

interface Cell {
  holderId: number | null;
  epoch: number; // only ever increments (monotonic per cell), even across dormancy
  lastSnapshot: ActorSnapshot | null;
  order: number[]; // arrival order of current occupants; front = longest-present
  enteredAt: Map<number, number>; // occupant -> when they arrived
  // When the holder last actually PRODUCED an actor frame — whether it is doing the job,
  // as opposed to merely being connected.
  lastActorFrame: number;
  grantedAt: number; // when the current holder took the cell (liveness grace starts here)
  silentReported: boolean; // reported once per silence, not once per sweep
}

export interface AuthorityOptions {
  now?: () => number; // tests drive the clock
  review?: boolean; // false: no periodic sweep (M7 weather reuses this class)
  // Absent = everyone is treated as capable (the pre-capability behaviour, which the fuzz
  // and tuning tests rely on).
  caps?: CapabilitySource;
}

export class Authority {
  private cells = new Map<string, Cell>();
  private readonly caps: CapabilitySource | undefined;
  private readonly now: () => number;
  private reviewTimer?: NodeJS.Timeout;

  constructor(
    private readonly send: AuthoritySenders,
    opts: AuthorityOptions = {},
  ) {
    this.caps = opts.caps;
    this.now = opts.now ?? Date.now;
    if (opts.review !== false) this.scheduleReview();
  }

  // Self-scheduled rather than driven from WorldState's queue: a cell whose holder is
  // degrading may see no enter/leave for hours, so churn is not a usable trigger. Safe to
  // run off-queue because review() is fully synchronous — it never awaits, so it cannot
  // interleave with an in-flight onEnter/onLeave — and it only ever touches cells that
  // already have a holder (a cell mid-claim has holderId null and is skipped).
  private scheduleReview(): void {
    const ms = authorityTuning.reviewMs;
    if (ms <= 0) return;
    this.reviewTimer = setTimeout(() => {
      try {
        this.reviewAll();
      } catch (err) {
        log('error', 'authority.review_failed', { error: String(err) });
      }
      this.scheduleReview();
    }, ms);
    this.reviewTimer.unref();
  }

  stop(): void {
    if (this.reviewTimer) clearTimeout(this.reviewTimer);
    this.reviewTimer = undefined;
  }

  // Every cell this player currently holds (a sim peer holds many via anchors).
  cellsHeldBy(playerId: number): string[] {
    const out: string[] = [];
    for (const [key, c] of this.cells) if (c.holderId === playerId) out.push(key);
    return out;
  }

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
      c = {
        holderId: null,
        lastActorFrame: 0,
        grantedAt: 0,
        epoch: 0,
        lastSnapshot: null,
        order: [],
        enteredAt: new Map(),
        silentReported: false,
      };
      this.cells.set(cellKey, c);
    }
    return c;
  }

  // Called on every accepted ActorMoveBatch from the holder. This is the liveness signal:
  // holding a cell says nothing about whether the holder is actually simulating it. A peer
  // that is loading, wedged or failing to authenticate produces nothing at all, and the
  // cell's NPCs freeze for everyone while the server believes it is fine.
  noteActorFrame(cellKey: string): void {
    const c = this.cells.get(cellKey);
    if (c) {
      c.lastActorFrame = this.now();
      c.silentReported = false;
    }
  }

  // The sim peer, if it is in this cell. There is no election: exactly one connection is
  // ever eligible, so this is a lookup, not a ranking. `except` exists for the leave path
  // (the holder walking out must not be handed its own cell back).
  private bestCandidate(c: Cell, except: number | null): number | null {
    for (const id of c.order) {
      if (id === except) continue;
      if (!this.caps || this.caps.canSimulate(id)) return id;
    }
    return null;
  }

  // Grant to `next` and refresh everyone else. Synchronous and complete: no window exists
  // where the cell has occupants and no holder.
  private handTo(c: Cell, cellKey: string, next: number, kind: string): void {
    c.holderId = next;
    c.epoch += 1;
    c.grantedAt = this.now();
    c.lastActorFrame = 0;
    metrics.cellAuthority.inc({ kind });
    this.send.grant(next, cellKey, c.epoch, c.lastSnapshot ?? EMPTY_SNAPSHOT);
    for (const other of c.order) if (other !== next) this.send.info(other, cellKey, next, c.epoch);
  }

  // ------------------------------------------------------------ transitions

  // A player's PlayerCellChange landed them in cellKey.
  async onEnter(playerId: number, cellKey: string): Promise<void> {
    const c = this.cell(cellKey);
    if (!c.order.includes(playerId)) c.order.push(playerId);
    if (!c.enteredAt.has(playerId)) c.enteredAt.set(playerId, this.now());
    // A client that cannot simulate must not claim a dormant cell either. The election
    // filter alone was not enough: onEnter grants a dormant cell DIRECTLY to the entrant
    // without consulting bestCandidate, so the first bot through the door still took it.
    // Leaving the cell dormant is strictly better than a holder that will never produce —
    // same simulation either way, without the server believing the job is covered — and the
    // next capable arrival claims it through this same path.
    // No occupancy condition: the bot is usually FIRST through the door, which is exactly
    // the case an `order.length > 1` guard would miss. There is nothing to report to them
    // either — with no holder there is no epoch to quote — so this simply returns.
    if (c.holderId === null && this.caps && !this.caps.canSimulate(playerId)) return;
    if (c.holderId === null) {
      // Fresh claim of a dormant/new cell: snapshot = in-memory last, else the doc
      // overrides (survives restart), else empty. No election to make — the entrant is the
      // only candidate, and an unheld cell simulates nothing at all.
      //
      // The seat is claimed SYNCHRONOUSLY, before the snapshot load. The load is awaited,
      // and the previous order (check holderId -> await -> assign) let two players entering
      // the same dormant cell in one tick both observe it free and both be granted: two
      // holders, and an epoch bumped twice so the first client's freshly-issued epoch was
      // already stale. Reachable only when there is no cached snapshot — a fresh or
      // just-restarted server, i.e. exactly when a crowd arrives at once.
      c.holderId = playerId;
      c.epoch += 1;
      c.grantedAt = this.now();
      c.lastActorFrame = 0;
      const snapshot = c.lastSnapshot ?? (await this.loadOr(cellKey));
      // Remember what the doc says the cell contains. The server ships no game data, so a
      // client snapshot is the ONLY way it can learn whether a cell has actors — and the
      // liveness check needs that answer for a holder that has never produced anything.
      // Without this, a freshly restarted server could not enforce liveness at all: the one
      // signal that would reveal the cell has NPCs is the very thing a silent holder is not
      // sending. Still a known limit on a genuinely first-ever visit to a cell, where no doc
      // and no snapshot exist yet; the check arms as soon as any snapshot has been seen.
      c.lastSnapshot = snapshot;
      metrics.cellAuthority.inc({ kind: 'grant' });
      this.send.grant(playerId, cellKey, c.epoch, snapshot);
      for (const other of c.order) if (other !== playerId) this.send.info(other, cellKey, playerId, c.epoch);
    } else if (c.holderId !== playerId) {
      this.send.info(playerId, cellKey, c.holderId, c.epoch);
    }
  }

  // A player left cellKey (cell change out, or disconnect). `connected` reports whether
  // the leaver is still on the server (false on disconnect → no Revoke to a dead socket).
  async onLeave(playerId: number, cellKey: string, connected: boolean): Promise<void> {
    const c = this.cells.get(cellKey);
    if (!c) return;
    c.order = c.order.filter((id) => id !== playerId);
    c.enteredAt.delete(playerId);
    if (c.holderId !== playerId) return; // a non-holder left; occupancy shrank, holder stands
    if (connected) this.send.revoke(playerId, cellKey, c.epoch);
    const next = this.bestCandidate(c, playerId);
    if (next !== null) {
      // Forced handoff: the seat is empty, so no margin test — take the fittest candidate.
      this.handTo(c, cellKey, next, 'handoff');
    } else {
      // Empty cell: fold the snapshot into the doc and go dormant (epoch retained).
      await this.send.foldOverrides(cellKey, c.lastSnapshot ?? EMPTY_SNAPSHOT);
      c.holderId = null;
      metrics.cellAuthority.inc({ kind: 'dormant' });
    }
  }

  // ------------------------------------------------------------- degradation

  // Periodic sweep: replace a holder that has been measurably bad for a sustained period,
  // and only by a candidate that is clearly better. Exposed for tests and for an embedder
  // that wants to drive the sweep itself.
  reviewAll(): void {
    for (const [cellKey, c] of this.cells) this.review(cellKey, c);
  }

  // LIVENESS ONLY. There is nothing to re-elect to: the sim peer is the sole eligible
  // holder, so a peer that has gone quiet cannot be replaced by a player — that fallback was
  // the client-authority model, and it is gone. A silent peer is an OPERATOR problem (crashed,
  // wedged, failing to authenticate), so it is reported loudly and left holding the cell.
  // Taking the cell away would only make the NPCs disappear as well as stop moving.
  private review(cellKey: string, c: Cell): void {
    const holder = c.holderId;
    if (holder === null) return;
    const now = this.now();

    // Only where there is something to simulate. A cell with no NPCs correctly produces no
    // actor frames — most interiors and plenty of exteriors — so without this every empty
    // cell would report a silent holder forever. The last snapshot is the server's own record
    // of whether the cell has actors; a stale one still answers the question, because NPCs do
    // not vanish because a holder went quiet.
    const snap = c.lastSnapshot as { actors?: unknown[] } | null;
    const cellHasActors = Array.isArray(snap?.actors) && snap.actors.length > 0;
    if (!cellHasActors || authorityTuning.actorSilenceMs <= 0) return;

    // Grace runs from the GRANT, so a peer that has just taken the cell is never judged
    // before it could have produced anything.
    const since = Math.max(c.lastActorFrame, c.grantedAt);
    if (now - since <= authorityTuning.actorSilenceMs) return;
    if (c.silentReported) return; // one line per silence, not one per sweep
    c.silentReported = true;
    metrics.cellAuthority.inc({ kind: 'silent' });
    log('error', 'authority.silent_peer', {
      cell: cellKey, holder, silentMs: Math.round(now - since),
    });
  }

  private async loadOr(cellKey: string): Promise<ActorSnapshot> {
    const overrides = await this.send.loadOverrides(cellKey);
    return overrides ?? EMPTY_SNAPSHOT;
  }
}
