// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
//
// HARNESS-ONLY LINK SHAPING (backlog #212). The browser harness drives raw CDP with no
// emulateNetworkConditions, so every latency feel bug (#197, #205, #211) was invisible on the
// LAN. Set OMWMP_NET_DELAY_MS=<rtt> on the world server and every connection -- players AND
// the sim peer -- gets an order-preserving FIFO on both send and receive, each holding a
// frame for rtt/2. OMWMP_NET_STALL=<ms>/<everyS> additionally freezes the FIFOs for <ms>
// every <everyS> seconds, which is what a TCP retransmit or a Wi-Fi roam looks like to the
// game (loss on TCP is a stall, never a gap). Unset: `netDelay` is undefined and the hot
// path is one `if`.

export interface StallSpec { ms: number; everyMs: number }

export class NetDelay {
  private readonly q: { due: number; fn: () => void }[] = [];
  private timer: NodeJS.Timeout | undefined;
  private lastDue = 0;

  constructor(readonly halfMs: number, readonly stall?: StallSpec, private readonly clock = Date.now) {}

  /** Earliest moment a frame handed over at `now` may go: after the one-way delay, and past
   *  the end of the stall window it fell into. Monotonic per FIFO, so order holds. */
  dueAt(now: number): number {
    let due = now + this.halfMs;
    if (this.stall) {
      const phase = now % this.stall.everyMs;
      if (phase < this.stall.ms) due = Math.max(due, now - phase + this.stall.ms);
    }
    if (due < this.lastDue) due = this.lastDue;
    this.lastDue = due;
    return due;
  }

  push(fn: () => void): void {
    this.q.push({ due: this.dueAt(this.clock()), fn });
    if (this.timer === undefined) this.arm();
  }

  private arm(): void {
    const head = this.q[0];
    if (!head) { this.timer = undefined; return; }
    this.timer = setTimeout(() => this.drain(), Math.max(0, head.due - this.clock()));
    this.timer.unref();
  }

  private drain(): void {
    const now = this.clock();
    while (this.q.length > 0 && this.q[0]!.due <= now) this.q.shift()!.fn();
    this.arm();
  }

  pending(): number { return this.q.length; }
}

export function netDelayFromEnv(env: NodeJS.ProcessEnv = process.env): (() => NetDelay) | undefined {
  const rtt = Number(env.OMWMP_NET_DELAY_MS ?? 0);
  const m = /^(\d+)\/(\d+(?:\.\d+)?)$/.exec(env.OMWMP_NET_STALL ?? '');
  const stall = m ? { ms: Number(m[1]), everyMs: Number(m[2]) * 1000 } : undefined;
  if (!(rtt > 0) && !stall) return undefined;
  return () => new NetDelay(rtt / 2, stall);
}
