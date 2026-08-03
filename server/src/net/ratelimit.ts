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

// Per-IP limiter for auth attempts (Register+Login), n per minute.
export class IpRateLimiter {
  private buckets = new Map<string, TokenBucket>();

  constructor(private readonly perMinute: number) {}

  allow(ip: string): boolean {
    // Unbounded-growth guard; buckets are tiny, drop-all is an acceptable reset.
    if (this.buckets.size > 10000) this.buckets.clear();
    let b = this.buckets.get(ip);
    if (!b) {
      b = new TokenBucket(this.perMinute / 60, this.perMinute);
      this.buckets.set(ip, b);
    }
    return b.take(1);
  }
}
