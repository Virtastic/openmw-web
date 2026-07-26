// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M4 actor-authority state machine (PROTOCOL.md §M4). One holder per cell simulates its
// NPCs/creatures; everyone else renders puppets off the wire. State per cell:
// {holderId, epoch, lastSnapshot, order}. `order` is the arrival sequence of current
// occupants. Every transition driven from WorldState runs INSIDE its single op queue, so
// contested entry resolves first-processed-wins and epochs advance deterministically.
//
// Election is by FITNESS, not seniority: the holder pays for everyone (it renders, plays
// AND simulates every NPC in the cell, then broadcasts), so handing the job to whoever
// merely arrived first can put it on the worst link in a 64-player cell. Fitness = the
// server's OWN smoothed RTT plus an outbound-shed penalty. A client-reported latency is
// never trusted: a modified client could report 1 ms to seize authority (and then feed
// everyone bad actor state) or 9999 ms to dodge the work.
//
// Seniority survives as the TIE-BREAK, which is what keeps the M4 contract intact: with no
// fitness data at all (fresh server, no pongs yet) every candidate scores identically and
// the choice collapses to order[0] — exactly the old behaviour.
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
  info(playerId: number, cellKey: string, holderId: number, epoch: number): void;
  // Dormant cell state: persisted in the cell doc, handed to the next claimant.
  loadOverrides(cellKey: string): Promise<ActorSnapshot>;
  foldOverrides(cellKey: string, snapshot: ActorSnapshot): Promise<void>;
}

// ------------------------------------------------------------------- tuning

export interface AuthorityTuning {
  // Score assumed for a player we have no RTT sample for yet. Deliberately mediocre: an
  // unmeasured candidate must not out-rank a measured good one, nor unseat a measured bad
  // one on nothing but optimism.
  unknownRttMs: number;
  // A shed rate of 1.0 (every lossy frame dropped) adds this many ms to the score. Shed is
  // a downstream symptom of a client that cannot drain; it belongs in the same currency.
  shedPenaltyMs: number;
  // A challenger must beat the incumbent by BOTH an absolute and a relative margin. The
  // absolute margin ignores jitter-sized differences; the ratio stops a big absolute win at
  // high RTT (350 vs 400) from counting as "clearly better" when both are unplayable.
  improveMs: number;
  improveRatio: number;
  // Degradation gate: the holder's score must sit above degradeScoreMs continuously for
  // sustainMs before it is even considered for replacement.
  degradeScoreMs: number;
  sustainMs: number;
  // After any fitness re-election, that cell is frozen for cooldownMs. A handoff costs a
  // snapshot + a full re-sync for every client in the cell, so flapping is strictly worse
  // than sitting on a mediocre holder.
  cooldownMs: number;
  // A player who just walked in may be about to walk out. Below settleMs they are not
  // electable while any settled occupant exists.
  settleMs: number;
  reviewMs: number; // 0 disables the periodic degradation sweep
}

// Live, mutable: WorldState builds its Authority in its own constructor and never sees the
// config, so server.ts pushes operator tuning here (order-independent — values are read at
// use time, not captured).
export const authorityTuning: AuthorityTuning = {
  unknownRttMs: 200,
  shedPenaltyMs: 500,
  improveMs: 40,
  improveRatio: 0.75,
  degradeScoreMs: 250,
  sustainMs: 30_000,
  cooldownMs: 60_000,
  settleMs: 20_000,
  reviewMs: 10_000,
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

// ------------------------------------------------------------------ fitness

export interface PlayerFitness {
  rttMs: number; // EWMA-smoothed
  shedRate: number; // EWMA of "this lossy frame was dropped", 0..1
  samples: number; // 0 = never measured; scored as unknown
}

export interface FitnessSource {
  get(playerId: number): PlayerFitness | undefined;
}

// One sample is a coin flip on a wifi link; the smoothing is what makes the signal usable
// without either lagging a real degradation by minutes or chasing every spike.
const RTT_ALPHA = 0.25; // ~10 samples to settle; at a 5 s probe that is ~50 s of memory
const SHED_ALPHA = 0.02; // per-frame, so much slower: ~50 frames
const MAX_RTT_MS = 60_000;

class FitnessTracker implements FitnessSource {
  private byPlayer = new Map<number, PlayerFitness>();

  private entry(playerId: number): PlayerFitness {
    let f = this.byPlayer.get(playerId);
    if (!f) {
      f = { rttMs: 0, shedRate: 0, samples: 0 };
      this.byPlayer.set(playerId, f);
    }
    return f;
  }

  // Server-measured only: called from the WS pong handler with (now - echoed ping stamp).
  sampleRtt(playerId: number, rttMs: number): void {
    if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > MAX_RTT_MS) {
      log('warn', 'authority.bad_rtt_sample', { player: playerId, rttMs: String(rttMs) });
      return;
    }
    const f = this.entry(playerId);
    f.rttMs = f.samples === 0 ? rttMs : f.rttMs + RTT_ALPHA * (rttMs - f.rttMs);
    f.samples++;
  }

  // Called per lossy outbound frame: true when the frame was dropped for backpressure.
  noteShed(playerId: number, shed: boolean): void {
    const f = this.entry(playerId);
    f.shedRate += SHED_ALPHA * ((shed ? 1 : 0) - f.shedRate);
  }

  get(playerId: number): PlayerFitness | undefined {
    const f = this.byPlayer.get(playerId);
    return f && f.samples > 0 ? f : undefined; // shed alone is not a latency estimate
  }

  forget(playerId: number): void {
    this.byPlayer.delete(playerId);
  }

  reset(): void {
    this.byPlayer.clear();
  }
}

// Module singleton: the sampler (net/ws.ts pongs, via the connection) and the consumer
// (Authority, built deep inside WorldState) have no shared constructor to thread through.
export const playerFitness = new FitnessTracker();

// -------------------------------------------------------------------- cells

interface Cell {
  holderId: number | null;
  epoch: number; // only ever increments (monotonic per cell), even across dormancy
  lastSnapshot: ActorSnapshot | null;
  order: number[]; // arrival order of current occupants; front = longest-present
  enteredAt: Map<number, number>; // occupant -> when they arrived (settle bias)
  badSince: number | null; // holder has scored above the degrade gate since this instant
  frozenUntil: number; // no fitness re-election before this instant (post-handoff damping)
}

const EMPTY_SNAPSHOT: ActorSnapshot = { actors: [] };

export interface AuthorityOptions {
  fitness?: FitnessSource; // tests inject; production reads the shared tracker
  now?: () => number; // tests drive the clock
  review?: boolean; // false: no periodic sweep (M7 weather reuses this class)
}

export class Authority {
  private cells = new Map<string, Cell>();
  private readonly fitness: FitnessSource;
  private readonly now: () => number;
  private reviewTimer?: NodeJS.Timeout;

  constructor(
    private readonly send: AuthoritySenders,
    opts: AuthorityOptions = {},
  ) {
    this.fitness = opts.fitness ?? playerFitness;
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
        epoch: 0,
        lastSnapshot: null,
        order: [],
        enteredAt: new Map(),
        badSince: null,
        frozenUntil: 0,
      };
      this.cells.set(cellKey, c);
    }
    return c;
  }

  // ---------------------------------------------------------------- scoring

  // One number, in milliseconds, lower is better. Unknown players score unknownRttMs so an
  // unmeasured candidate ties with an unmeasured incumbent — which the tie-break then
  // resolves by seniority, reproducing pre-fitness behaviour exactly.
  private score(playerId: number): number {
    const f = this.fitness.get(playerId);
    if (!f) return authorityTuning.unknownRttMs;
    return f.rttMs + f.shedRate * authorityTuning.shedPenaltyMs;
  }

  // Best candidate among `order`, excluding `except`. Newcomers are held back while any
  // settled occupant exists; ties resolve to the longest-present, so the result is a pure
  // function of state (the fuzz depends on this determinism).
  private bestCandidate(c: Cell, except: number | null): number | null {
    const now = this.now();
    const pool = c.order.filter((id) => id !== except);
    if (pool.length === 0) return null;
    const settled = pool.filter((id) => now - (c.enteredAt.get(id) ?? now) >= authorityTuning.settleMs);
    const from = settled.length > 0 ? settled : pool;
    let best = from[0]!;
    let bestScore = this.score(best);
    for (const id of from) {
      const s = this.score(id);
      if (s < bestScore) {
        best = id;
        bestScore = s;
      }
      // Equal scores keep the earlier entry: `from` preserves arrival order.
    }
    return best;
  }

  private clearlyBetter(challenger: number, incumbent: number): boolean {
    const a = this.score(challenger);
    const b = this.score(incumbent);
    return a <= b - authorityTuning.improveMs && a <= b * authorityTuning.improveRatio;
  }

  // Grant to `next` and refresh everyone else. Synchronous and complete: no window exists
  // where the cell has occupants and no holder.
  private handTo(c: Cell, cellKey: string, next: number, kind: string): void {
    c.holderId = next;
    c.epoch += 1;
    c.badSince = null;
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
    if (c.holderId === null) {
      // Fresh claim of a dormant/new cell: snapshot = in-memory last, else the doc
      // overrides (survives restart), else empty. No election to make — the entrant is the
      // only candidate, and an unheld cell simulates nothing at all.
      const snapshot = c.lastSnapshot ?? (await this.loadOr(cellKey));
      c.holderId = playerId;
      c.epoch += 1;
      c.badSince = null;
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
      c.badSince = null;
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

  private review(cellKey: string, c: Cell): void {
    const holder = c.holderId;
    if (holder === null || c.order.length < 2) {
      c.badSince = null;
      return;
    }
    const now = this.now();
    const bad = this.score(holder) > authorityTuning.degradeScoreMs;
    if (!bad) {
      c.badSince = null; // hysteresis: recovery resets the clock, one good sample is enough
      return;
    }
    if (c.badSince === null) c.badSince = now;
    if (now - c.badSince < authorityTuning.sustainMs) return; // one bad sample proves nothing
    if (now < c.frozenUntil) return; // still damped from the last handoff
    const next = this.bestCandidate(c, holder);
    if (next === null || !this.clearlyBetter(next, holder)) return;
    log('info', 'authority.reelect', {
      cell: cellKey,
      from: holder,
      to: next,
      fromScore: Math.round(this.score(holder)),
      toScore: Math.round(this.score(next)),
    });
    this.send.revoke(holder, cellKey, c.epoch);
    c.frozenUntil = now + authorityTuning.cooldownMs;
    this.handTo(c, cellKey, next, 'reelect');
  }

  private async loadOr(cellKey: string): Promise<ActorSnapshot> {
    const overrides = await this.send.loadOverrides(cellKey);
    return overrides ?? EMPTY_SNAPSHOT;
  }
}
