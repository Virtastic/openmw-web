// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// PEER LOAD, as the server can see it (OT3-70).
//
// The peer sets the capacity ceiling: it steps a fixed 1/20 s, and a frame over 50 ms slows sim
// time for the whole world. The peer does not report its own frame time (that needs engine
// work), but it streams ActorMoveBatch every frame it simulates, so the RECEIVING end can
// measure the cadence: a burst of batches is one frame, and the gap between bursts is the frame
// interval. Interval p99 over 50 ms is the same symptom as a slow frame.
//
//   frame interval  = time between the first batch of consecutive bursts (ms)
//   sim/real ratio  = 50 ms / mean interval, capped at 1 (1.0 = the world runs at real time)
//
// This is a PROXY measured on arrival, so it includes network and event-loop delay between peer
// and server (loopback in production). Treat it as the ceiling indicator, not an engine profile;
// OPENMW_OSG_STATS_FILE remains the engine-side source for a real run.

/** Fixed sim step the peer is paced to (settings.cfg framerate limit 20). */
export const PEER_STEP_MS = 50;
/** Batches closer together than this belong to the same frame. */
const BURST_GAP_MS = 10;
const WINDOW = 400; // ~20 s of frames

interface RegionSeries {
  lastBatchAt?: number;
  lastBurstAt?: number;
  intervals: number[]; // ring of the last WINDOW frame intervals
  next: number;
  actors: number; // actors in the most recent batch burst, summed across cells
  burstActors: number;
}

export interface PeerLoadSample { p50: number; p99: number; simReal: number; frames: number; actors: number }

export class PeerLoad {
  private readonly regions = new Map<string, RegionSeries>();

  /** One ActorMoveBatch arrived from the region's peer, carrying `actorCount` actors. */
  noteBatch(region: string, nowMs: number, actorCount: number): void {
    let s = this.regions.get(region);
    if (!s) { s = { intervals: [], next: 0, actors: 0, burstActors: 0 }; this.regions.set(region, s); }
    const newBurst = s.lastBatchAt === undefined || nowMs - s.lastBatchAt >= BURST_GAP_MS;
    if (newBurst) {
      if (s.lastBurstAt !== undefined) {
        const iv = nowMs - s.lastBurstAt;
        if (s.intervals.length < WINDOW) s.intervals.push(iv);
        else { s.intervals[s.next] = iv; s.next = (s.next + 1) % WINDOW; }
      }
      s.lastBurstAt = nowMs;
      s.actors = s.burstActors; // the burst that just finished
      s.burstActors = 0;
    }
    s.burstActors += actorCount;
    s.lastBatchAt = nowMs;
  }

  regionsSeen(): string[] { return [...this.regions.keys()]; }

  sample(region: string, nowMs = Date.now(), staleMs = 5_000): PeerLoadSample | undefined {
    const s = this.regions.get(region);
    if (!s || s.intervals.length === 0) return undefined;
    // A peer that went quiet is not "fast": report the silence as the interval.
    const quiet = s.lastBatchAt !== undefined && nowMs - s.lastBatchAt > staleMs ? nowMs - s.lastBatchAt : 0;
    const sorted = [...s.intervals].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    return {
      p50: Math.max(q(0.5), quiet),
      p99: Math.max(q(0.99), quiet),
      simReal: Math.min(1, PEER_STEP_MS / Math.max(mean, quiet || mean, 1)),
      frames: s.intervals.length,
      actors: s.actors,
    };
  }

  /** Forget a region's history (its peer restarted). */
  reset(region: string): void { this.regions.delete(region); }
}
