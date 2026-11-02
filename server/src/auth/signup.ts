// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
//
// NEW ACCOUNTS PER ADDRESS, shared by SSO sign-up (auth/routes.ts). Ten (a household or a LAN
// party), then one every twenty minutes. A ban is only worth something if minting the next
// account costs more than a click.
//
// OT3-40: this file used to hold the invite passphrase gate as well. The invite code is gone
// (a private-world concept); this limiter, and the H2 probation/verified-email rules, are the
// signup abuse controls now.
//
// ponytail: in-memory and per process (a restart resets the budget).
import { IpRateLimiter } from '../net/ratelimit';

let signups = new IpRateLimiter(3 / 60, 10);

/** False when this address has created its budget of accounts; spends one when true. */
export function allowSignup(ip: string): boolean {
  return signups.allow(ip);
}

/** Tests only: a fresh budget. */
export function resetSignupBudget(): void {
  signups = new IpRateLimiter(3 / 60, 10);
}
