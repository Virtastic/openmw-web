// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
//
// THE INVITE PASSPHRASE GATE, shared by SSO sign-up (auth/routes.ts) and password sign-up
// (net/connection.ts).
//
// An operator picks the passphrase, so it is often guessable ("friends2026"), and the only
// thing that stood in front of it was the general auth budget: 5 attempts a minute per IP,
// 300 guesses an hour from one address and no limit at all across addresses. So guesses
// are budgeted on their own, per caller key (the IP, and the SSO identity when there is one)
// AND server-wide, so rotating addresses or accounts buys nothing.
//
// EVERY ATTEMPT IS CHARGED, RIGHT OR WRONG, BEFORE THE COMPARISON. A legitimate player
// spends one; and charging first is what makes the lockout mean something, because a
// correct guess made while locked out is refused like any other.
//
// ponytail: in-memory and per process (the gateway and each world count separately, and a
// restart resets the budgets). Persist the counters if restarts become an attack vector.
import { createHash, timingSafeEqual } from 'node:crypto';
import { IpRateLimiter, TokenBucket } from '../net/ratelimit';
import { log } from '../log';

let perKey = new IpRateLimiter(5 / 60, 5); // 5 tries, then one every 12 minutes
// Server-wide ceiling, 20 an hour. The cost: somebody burning it holds up NEW players for up
// to an hour (returning players never reach this gate). Logged, so the operator sees it.
let serverWide = new TokenBucket(20 / 3600, 20);

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/**
 * 'ok' when no passphrase is set or `given` matches; 'wrong' when it does not; 'locked' when
 * this caller or the server as a whole has used up its guesses (not compared at all).
 */
export function checkInvite(expected: string, given: string | undefined, keys: string[]): 'ok' | 'wrong' | 'locked' {
  if (expected === '') return 'ok';
  for (const k of keys) {
    if (!perKey.allow(k)) { log('warn', 'auth.invite_locked', { scope: 'caller' }); return 'locked'; }
  }
  if (!serverWide.take(1)) { log('warn', 'auth.invite_locked', { scope: 'server' }); return 'locked'; }
  // Hashed first so the constant-time compare gets equal lengths, and a length mismatch
  // leaks nothing either.
  return timingSafeEqual(digest(given ?? ''), digest(expected)) ? 'ok' : 'wrong';
}

/** Tests only: fresh budgets. */
export function resetInviteBudgets(): void {
  perKey = new IpRateLimiter(5 / 60, 5);
  serverWide = new TokenBucket(20 / 3600, 20);
}
