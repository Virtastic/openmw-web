// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// One gate for the whole dashboard.
//
// Two credentials converge here and then nothing downstream cares which one arrived:
//
//   1. A SESSION token minted by /admin/login (password + optional TOTP) or by the SSO
//      round trip. Carries the account's dashboardRole.
//   2. The legacy [admin].dashboardToken bearer, treated as `moderator` (see below for why
//      it is not `owner`, which is what this line used to claim). Automation was built
//      against it before accounts existed and breaking that would be a silent outage in
//      someone's cron job, so it keeps working — but it is no longer the only way in.
//
// Having exactly ONE resolve function is the point. Two parallel checks is how an endpoint
// ends up gated by the weaker of them, which is the "privilege creep" failure this design
// was explicitly asked to prevent.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AccountStore, DashboardRole } from '../../core/accounts';
import { roleAtLeast } from '../../core/accounts';
import type { AdminSessionStore } from '../../auth/identities';
import type { IpRateLimiter } from '../ratelimit';
import { clientIp } from '../http';
import { json } from './util';
import { log } from '../../log';

export interface AuthContext {
  role: DashboardRole;
  accountKey: string;
  accountName: string;
  /** True when the caller used the legacy shared token rather than a real account. */
  viaSharedToken: boolean;
}

export interface AuthDeps {
  sharedToken: string;
  accounts: AccountStore;
  sessions: AdminSessionStore;
  /** Per-IP budget for login attempts. */
  loginLimiter: IpRateLimiter;
  /** Per-IP budget for every other authenticated call — a stolen session is still bounded. */
  apiLimiter: IpRateLimiter;
}

function tokenFrom(req: IncomingMessage): string {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : '';
}

function sharedTokenOk(presented: string, want: string): boolean {
  if (want === '' || presented === '') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Who is calling, and with what authority? `null` means unauthenticated — never means
 * "probably fine".
 */
export async function resolveAuth(
  req: IncomingMessage,
  deps: AuthDeps,
): Promise<AuthContext | null> {
  const presented = tokenFrom(req);
  if (presented === '') return null;

  if (sharedTokenOk(presented, deps.sharedToken)) {
    // MODERATOR, not owner. This token predates roles and is documented as covering exactly
    // what the old dashboard did: watch the world, read the report queue, kick/ban/mute/
    // broadcast. Resolving it to owner silently upgraded every copy of it — and copies live
    // in cron jobs, CI config and monitoring dashboards precisely because it was understood
    // to be low-privilege — into a credential that can run script on players' machines,
    // rewrite every setting and download the entire data directory.
    //
    // Every route the old dashboard exposed is moderator or below, so nothing that worked
    // before stops working. Owner-level automation should be a real account with a real role,
    // which is auditable by name rather than appearing in the log as a shared secret.
    return {
      role: 'moderator',
      accountKey: '(shared-token)',
      accountName: '(shared-token)',
      viaSharedToken: true,
    };
  }

  const accountKey = deps.sessions.resolve(presented);
  if (!accountKey) return null;

  // Re-read the account on EVERY request rather than trusting the role baked in at login:
  // demoting or banning someone has to take effect now, not whenever their session happens
  // to expire.
  const account = await deps.accounts.get(accountKey);
  if (!account || !account.dashboardRole || account.banned) {
    deps.sessions.revokeAccount(accountKey);
    return null;
  }
  return {
    role: account.dashboardRole,
    accountKey,
    accountName: account.name,
    viaSharedToken: false,
  };
}

/**
 * Gate a request at `need`. Answers the response and returns null when refused, so a route
 * reads `const ctx = await gate(...); if (!ctx) return true;`.
 *
 * 401 for "no valid credential", 403 for "valid credential, insufficient role" — the
 * distinction matters to the page, which must send an under-privileged user to a "you
 * cannot see this" state rather than back to a login form that will not help them.
 */
export async function gate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AuthDeps,
  need: DashboardRole,
  /**
   * Exempt this route from the per-request budget.
   *
   * For BULK FILE UPLOAD, and only that. Morrowind's Data Files folder is thousands of
   * files sent one request each, and the budget is 600/minute — ten a second, which is
   * exactly the rate a local upload runs at. So the one operation the wizard depends on
   * sat permanently on the limit and failed intermittently, reported to the operator as
   * "everything failed" with no cause.
   *
   * Safe because the budget buys nothing here: the route is owner-only, and an owner can
   * already restart the server and rewrite every setting. What actually bounds an upload is
   * the disk and the network, not a token bucket. Every other route keeps the budget, which
   * is what protects the cheap-to-call, expensive-to-serve endpoints it was written for.
   */
  exemptFromBudget = false,
): Promise<AuthContext | null> {
  // Messages are written for the person reading them, not for a log. The dashboard surfaces
  // these verbatim in a toast, and "forbidden" tells someone nothing about what to do next.
  const ctx = await resolveAuth(req, deps);
  if (!ctx) {
    json(res, 401, { error: 'You are not signed in any more. Sign in again to continue.' });
    return null;
  }
  if (!exemptFromBudget && !deps.apiLimiter.allow(clientIp(req))) {
    json(res, 429, { error: 'Too many requests. Wait a moment and try again.' });
    return null;
  }
  if (!roleAtLeast(ctx.role, need)) {
    log('warn', 'admin.denied', { account: ctx.accountKey, need, have: ctx.role });
    json(res, 403, {
      error: `Your role (${ctx.role}) cannot do this — it needs ${need}. Ask an owner.`,
      need,
    });
    return null;
  }
  return ctx;
}

export type LoginResult =
  | { ok: true; token: string; role: DashboardRole; name: string }
  | { ok: false; status: number; error: string; totpRequired?: boolean };

/**
 * Password login. Every failure returns the same generic message: distinguishing "no such
 * account" from "wrong password" from "not an admin" hands an attacker a free account
 * oracle, and the operator typing it already knows which of those they meant.
 */
export async function passwordLogin(
  deps: AuthDeps,
  ip: string,
  name: string,
  password: string,
  totp: string,
): Promise<LoginResult> {
  if (!deps.loginLimiter.allow(ip)) {
    return { ok: false, status: 429, error: 'Too many sign-in attempts. Wait a minute and try again.' };
  }
  const account = await deps.accounts.verifyLogin(name, password);
  if (!account || !account.dashboardRole || account.banned) {
    log('warn', 'admin.login_failed', { name, ip });
    return { ok: false, status: 401, error: 'That username and password did not match.' };
  }
  if (account.totpSecret) {
    // Import lazily-ish: keeping verifyTotp out of the module graph until an account is
    // actually enrolled is not worth the indirection, so this is a plain call.
    const { verifyTotp } = await import('./totp');
    if (totp === '') {
      return { ok: false, status: 401, error: 'Enter the six-digit code from your authenticator app.', totpRequired: true };
    }
    if (!verifyTotp(account.totpSecret, totp)) {
      log('warn', 'admin.login_totp_failed', { name, ip });
      return {
        ok: false,
        status: 401,
        // Naming the likeliest cause: a phone whose clock has drifted is by far the most
        // common reason a correct-looking code is refused.
        error: 'That code did not match. Check your phone’s clock is set automatically.',
        totpRequired: true,
      };
    }
  }
  const key = account.name.toLowerCase();
  const token = deps.sessions.mint(key, ip);
  log('info', 'admin.login', { account: key, ip, role: account.dashboardRole });
  return { ok: true, token, role: account.dashboardRole, name: account.name };
}

/**
 * Password strength for dashboard accounts. Deliberately a length floor plus a blocklist of
 * the handful of strings people actually type, not a character-class maze: length is the
 * only rule that reliably buys entropy, and "must contain a symbol" mostly buys "Password1!".
 */
const WEAK = new Set([
  'password', 'password1', 'password123', 'admin', 'admin123', 'administrator',
  'letmein', 'changeme', 'qwerty', 'qwerty123', '12345678', '123456789', '1234567890',
  'openmw', 'morrowind', 'virtastic', 'iloveyou', 'welcome', 'welcome1', 'abc12345',
]);

export function passwordProblem(password: string, name: string): string | null {
  if (password.length < 12) return 'must be at least 12 characters';
  if (password.length > 200) return 'must be under 200 characters';
  const lower = password.toLowerCase();
  if (WEAK.has(lower)) return 'that is one of the most common passwords in the world';
  if (name !== '' && lower.includes(name.toLowerCase())) return 'must not contain the username';
  if (/^(.)\1+$/.test(password)) return 'must not be a single repeated character';
  return null;
}
