// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Token buckets (per-session msgs+bytes, per-IP login attempts) and per-IP connection caps.

export class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  // burst defaults to one second's worth of tokens.
  constructor(
    private readonly ratePerSec: number,
    private readonly burst = ratePerSec,
  ) {
    this.tokens = this.burst;
  }

  take(n: number): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.lastRefill) / 1000) * this.ratePerSec);
    this.lastRefill = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

export class IpConnTracker {
  private counts = new Map<string, number>();

  constructor(private readonly maxPerIp: number) {}

  acquire(ip: string): boolean {
    const n = this.counts.get(ip) ?? 0;
    if (n >= this.maxPerIp) return false;
    this.counts.set(ip, n + 1);
    return true;
  }

  release(ip: string): void {
    const n = this.counts.get(ip) ?? 0;
    if (n <= 1) this.counts.delete(ip);
    else this.counts.set(ip, n - 1);
  }
}

const MAX_BUCKETS = 10_000;

// Per-IP limiter for auth attempts (Register+Login), n per minute.
export class IpRateLimiter {
  private buckets = new Map<string, TokenBucket>();

  constructor(private readonly perMinute: number) {}

  allow(ip: string): boolean {
    let b = this.buckets.get(ip);
    if (b) {
      // Re-insert to move this key to the end: a Map iterates in insertion order, so deleting
      // from the front then evicts the LEAST RECENTLY USED rather than the oldest-created.
      this.buckets.delete(ip);
      this.buckets.set(ip, b);
    } else {
      b = new TokenBucket(this.perMinute / 60, this.perMinute);
      this.buckets.set(ip, b);
    }
    // Unbounded-growth guard. This used to be `if (size > 10000) clear()` — which made the
    // guard the BYPASS: 10,001 addresses wiped every bucket including the one throttling an
    // attacker's brute force, and holding the map above the mark turned rate limiting off
    // permanently. Evicting one LRU entry per insert bounds the map without ever resetting the
    // bucket of whoever is actually hammering us, because they are the most recently used.
    while (this.buckets.size > MAX_BUCKETS) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) break;
      this.buckets.delete(oldest.value);
    }
    return b.take(1);
  }
}
