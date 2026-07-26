// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M1 movement relay: occupancy/visibility rules and the 66 ms PlayerMoveBatch tick.
// Visibility = same cellKey, or both exterior ("x,y" ints) with Chebyshev distance <= 1.
// A player with no cellKey yet is visible to nobody (the client sends PlayerCellChange
// right after Ready).
//
// M9 capacity: cell-granular visibility alone makes one busy cell an N x N pose mesh, and
// the binding constraint at 64 co-located players is CLIENT cost (render + interpolate 63
// avatars on top of the NPCs), not bandwidth. So on top of the cell rule this module adds
// interest management (distance culling with hysteresis and a nearest-K floor) and LOD
// (send rate as a function of distance). Both shrink what each client must draw.

import type { Player, Roster } from './players';
import type { Config } from '../config';
import { MSG_PLAYER_MOVE_BATCH, packEnvelope, nextBroadcastSeq } from '../proto/envelope';
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

// ------------------------------------------------- interest management + LOD

// Radii are pre-SQUARED and rates pre-converted to tick strides: the recipient x sender
// inner loop runs ~62k times/s at 64 co-located players, so it must not take a sqrt, do a
// division, or allocate.
export interface InterestSettings {
  cull: boolean; // false when interestRadius = 0 (culling off; LOD still applies)
  enterR2: number; // must be within this to ENTER a peer's view
  exitR2: number; // stays in view until beyond this — strictly wider than enterR2
  minPeers: number; // nearest-K floor: always in view, radius or not
  nearR2: number;
  midR2: number;
  nearStride: number; // ticks between sends for the near tier (1 = every tick)
  midStride: number;
  farStride: number;
}

// Nominal cadence of a holder's ActorMoveBatch stream — the same 15 Hz the pose tick runs
// at, so actor tiering reuses the pose strides rather than inventing a second schedule.
export const ACTOR_STREAM_INTERVAL_MS = BATCH_INTERVAL_MS;

function stride(hz: number, intervalMs: number): number {
  return Math.max(1, Math.round(1000 / hz / intervalMs));
}

export function interestFromLimits(limits: Config['limits'], intervalMs = BATCH_INTERVAL_MS): InterestSettings {
  const enter = limits.interestRadius;
  return {
    cull: enter > 0,
    enterR2: enter * enter,
    // Hysteresis is expressed as an absolute band, not a ratio: it is a DISTANCE the player
    // has to re-cover to flip state, which is what actually sets the flap period.
    exitR2: (enter + limits.interestHysteresis) ** 2,
    minPeers: limits.interestMinPeers,
    nearR2: limits.lodNearRadius ** 2,
    midR2: limits.lodMidRadius ** 2,
    nearStride: stride(limits.lodNearHz, intervalMs),
    midStride: stride(limits.lodMidHz, intervalMs),
    farStride: stride(limits.lodFarHz, intervalMs),
  };
}

// d2 < 0 means "distance not comparable" (interior, or a pose we do not have yet) —
// those always get the near tier and are never culled.
export function lodStride(d2: number, s: InterestSettings): number {
  if (d2 < 0 || d2 <= s.nearR2) return s.nearStride;
  return d2 <= s.midR2 ? s.midStride : s.farStride;
}

// Per-(recipient, sender) relay state. Presence in the recipient's map IS the hysteresis
// "currently in view" bit.
interface View {
  version: number; // last poseVersion actually DELIVERED; -1 = none yet (force-include)
  seenTick: number; // last tick this pair was in the interest set (sweep marker)
  sent: boolean; // a pose landed -> the client spawned a puppet -> it needs a leave signal
}

// Per-recipient change tracking: an unknown sender (join, cell entry, or re-entering the
// interest radius) has version -1, which force-includes them in the next batch — one
// mechanism covers dirty-poses, force-include-on-visibility, and force-include-on-approach.
export class MoveBroadcaster {
  private perRecipient = new Map<number, Map<number, View>>();
  private timer?: NodeJS.Timeout;
  private tickNo = 0;
  private readonly s: InterestSettings;
  // Scratch reused across recipients and ticks: allocating a Set and two arrays per
  // recipient per tick was ~4k throwaway objects/s at 64 players.
  private readonly inSet: Player[] = [];
  private readonly inD2: number[] = [];
  private readonly outSet: Player[] = [];
  private readonly outD2: number[] = [];
  private readonly entries: BatchEntry[] = [];
  private readonly stagedViews: View[] = [];
  private readonly stagedVer: number[] = [];

  constructor(
    private readonly roster: Roster,
    private readonly intervalMs = BATCH_INTERVAL_MS,
    settings?: InterestSettings,
  ) {
    // No settings = culling off, everything near tier: the M1 behaviour, so a caller that
    // does not opt in cannot silently lose peers.
    this.s = settings ?? {
      cull: false,
      enterR2: 0,
      exitR2: 0,
      minPeers: 0,
      nearR2: Infinity,
      midR2: Infinity,
      nearStride: 1,
      midStride: 1,
      farStride: 1,
    };
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  tick(): void {
    const inWorld = this.roster.inWorld();
    const tickNo = ++this.tickNo;
    // One seq for the whole tick: each recipient gets at most one batch from it, so every
    // socket still sees a strictly increasing sequence (see nextBroadcastSeq).
    const seq = nextBroadcastSeq();
    const liveIds = new Set<number>();
    for (const p of inWorld) liveIds.add(p.id);
    // Drop state for recipients that left.
    for (const id of this.perRecipient.keys()) if (!liveIds.has(id)) this.perRecipient.delete(id);

    for (const recipient of inWorld) {
      let views = this.perRecipient.get(recipient.id);
      if (!views) {
        views = new Map();
        this.perRecipient.set(recipient.id, views);
      }
      this.selectPeers(recipient, inWorld, views);
      this.buildBatch(recipient, views, tickNo);
      this.sweep(recipient, views, tickNo);
      this.flush(recipient, seq, tickNo);
    }
  }

  // Splits the cell-visible senders into in-interest (inSet) and culled (outSet), then
  // applies the nearest-K floor. Distance is only meaningful between two EXTERIOR cells:
  // interiors stay cell-granular because there "far" is an occlusion question, not a
  // distance one, and a radius tuned for open terrain would pop peers standing one wall
  // away in a canton.
  private selectPeers(recipient: Player, inWorld: Player[], views: Map<number, View>): void {
    const s = this.s;
    this.inSet.length = 0;
    this.inD2.length = 0;
    this.outSet.length = 0;
    this.outD2.length = 0;
    // One regex per recipient per tick, not per pair: if the recipient's cell is exterior
    // then every cell-visible sender's cell is exterior too (same key or an adjacent grid
    // cell), so this single parse decides comparability for the whole inner loop.
    const rPose = recipient.cellKey !== undefined && parseExterior(recipient.cellKey) ? recipient.pose : undefined;

    for (const sender of inWorld) {
      if (sender.id === recipient.id) continue;
      if (!cellsVisible(recipient.cellKey, sender.cellKey)) continue;
      let d2 = -1;
      if (rPose && sender.pose) {
        const dx = sender.pose.x - rPose.x;
        const dy = sender.pose.y - rPose.y;
        const dz = sender.pose.z - rPose.z;
        d2 = dx * dx + dy * dy + dz * dz;
        // Hysteresis: the threshold to STAY in view is wider than the threshold to ENTER
        // it. Without this, a player pacing the boundary spawns and despawns on every
        // other tick in 63 other clients.
        if (s.cull && d2 > (views.has(sender.id) ? s.exitR2 : s.enterR2)) {
          this.outSet.push(sender);
          this.outD2.push(d2);
          continue;
        }
      }
      this.inSet.push(sender);
      this.inD2.push(d2);
    }

    // Nearest-K floor: culling must never make someone feel alone in a crowd, so the K
    // closest peers are in view whatever the radius says. Only sorts when the floor
    // actually bites, which in a crowded cell is never.
    const need = Math.min(s.minPeers - this.inSet.length, this.outSet.length);
    if (need > 0) {
      const order = this.outSet.map((_, i) => i).sort((a, b) => this.outD2[a]! - this.outD2[b]!);
      for (let i = 0; i < need; i++) {
        const j = order[i]!;
        this.inSet.push(this.outSet[j]!);
        this.inD2.push(this.outD2[j]!);
      }
    }
  }

  private buildBatch(recipient: Player, views: Map<number, View>, tickNo: number): void {
    const s = this.s;
    this.entries.length = 0;
    this.stagedViews.length = 0;
    this.stagedVer.length = 0;
    for (let i = 0; i < this.inSet.length; i++) {
      const sender = this.inSet[i]!;
      let view = views.get(sender.id);
      if (!view) {
        view = { version: -1, seenTick: tickNo, sent: false };
        views.set(sender.id, view);
      } else {
        view.seenTick = tickNo; // mark BEFORE any skip: skipped != out of view
      }
      if (!sender.pose) continue; // nothing to relay yet
      if (view.version === sender.poseVersion) continue; // unchanged since last batch
      // LOD. version < 0 is a first sighting or a re-entry: it bypasses the stride so the
      // puppet appears immediately rather than up to a second later. The id term spreads
      // the low-rate tiers across ticks instead of bunching every far peer onto one frame.
      if (view.version >= 0) {
        const st = lodStride(this.inD2[i]!, s);
        if (st > 1 && (tickNo + sender.id) % st !== 0) continue;
      }
      if (this.entries.length >= 255) break;
      this.entries.push({ id: sender.id, pose: sender.pose });
      // Staged, NOT committed: the send below can be shed under backpressure, and marking
      // a pose delivered that never left leaves this recipient stale until the sender
      // moves again — which for someone standing still never happens.
      this.stagedViews.push(view);
      this.stagedVer.push(sender.poseVersion);
    }
  }

  // Forget senders that left the interest set so their return force-includes, and tell the
  // client to despawn the puppet. Without an explicit signal the peer keeps a GHOST frozen
  // at the boundary forever — a stale timeout is not good enough, it leaves visible corpses
  // standing around for seconds.
  private sweep(recipient: Player, views: Map<number, View>, tickNo: number): void {
    for (const [id, view] of views) {
      if (view.seenTick === tickNo) continue;
      views.delete(id);
      // Only when a pose actually landed: `sent` false means the client never spawned a
      // puppet for this id, so a despawn would be noise. Exactly one signal per transition
      // — the map entry is gone, so a re-entry starts from scratch.
      if (view.sent) recipient.peer.sendEvent('PlayerLeaveView', { id });
    }
  }

  private flush(recipient: Player, seq: number, tickNo: number): void {
    if (this.entries.length === 0) return;
    const frame = packEnvelope(MSG_PLAYER_MOVE_BATCH, seq, packMoveBatch(this.entries));
    if (!recipient.peer.sendBinaryFrame(MSG_PLAYER_MOVE_BATCH, frame)) return;
    for (let i = 0; i < this.stagedViews.length; i++) {
      const view = this.stagedViews[i]!;
      view.version = this.stagedVer[i]!;
      view.seenTick = tickNo;
      view.sent = true;
    }
  }
}
