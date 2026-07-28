// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase B HTTP surface:
//   GET /auth/providers          -> which providers this server offers (client renders buttons)
//   GET /auth/:provider/start    -> 302 to the provider, PKCE + state + nonce minted here
//   GET /auth/:provider/callback -> server-side code exchange, then 302 back to the game
//   GET /auth/link/:provider     -> same round trip, but binds to the CALLER's account
//
// Everything lands back on [auth].returnUrl with the result in the URL FRAGMENT
// (#mpticket=... / #mperror=... / #mplink=...). A fragment is never sent to a server, never
// written to an access log and never leaks through Referer — a query parameter would be
// all three, and this ticket is a credential.
//
// The return target is ALWAYS the configured one. A `return`/`redirect_uri` parameter from
// the caller is ignored on purpose: honouring it would make this an open redirector, which
// is the classic way an authorization code (or ticket) gets stolen.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../config';
import type { AccountStore } from '../core/accounts';
import type { BanStore } from '../persist/banstore';
import type { IpRateLimiter } from '../net/ratelimit';
import { clientIp, isSecureRequest, readCookie, redirect, sendJson, sendText, setCookie, type HttpRoute } from '../net/http';
import { OidcError, OidcService, isProviderId, type ProviderId } from './oidc';
import { IdentityStore, LoginTicketStore, SessionIndex, LockerSessionStore, resolveSsoAccount } from './identities';
import { log } from '../log';
import { metrics } from '../metrics';

const STATE_COOKIE = 'omwmp_oauth';
const COOKIE_PATH = '/auth'; // sent on the callback, on nothing else
const STATE_COOKIE_MAX_AGE = 600;

export interface AuthDeps {
  config: Config;
  oidc: OidcService;
  identities: IdentityStore;
  tickets: LoginTicketStore;
  sessions: SessionIndex;
  lockerSessions?: LockerSessionStore; // Phase 3.5: minted at SSO login so the browser can upload before joining
  accounts: AccountStore;
  bans: BanStore;
  limiter: IpRateLimiter; // shares the operator's per-IP auth budget
}

// Appends the outcome to the operator's return URL as a fragment, replacing any fragment
// the operator wrote there (a stale one would shadow ours).
function returnTo(returnUrl: string, fragment: string): string {
  const hash = returnUrl.indexOf('#');
  const base = hash === -1 ? returnUrl : returnUrl.slice(0, hash);
  return `${base}#${fragment}`;
}

// `also` is chained AFTER the SSO routes: createHttpServer takes exactly one extra-route
// hook, and threading a list through it would touch every caller for one composition.
export function createAuthRoutes(deps: AuthDeps, also?: HttpRoute): HttpRoute {
  const { config, oidc, identities, tickets, sessions, lockerSessions, accounts, bans, limiter } = deps;

  // A failure the player caused (or a provider refused) goes back to the game page as a
  // machine-readable code; the human-readable reason stays in the server log. Nothing the
  // provider wrote is ever reflected into the response.
  const fail = (res: ServerResponse, code: string, detail: string, ip: string): true => {
    log('warn', 'auth.sso_failed', { code, detail, ip });
    metrics.auth.inc({ op: 'sso', result: 'AUTH_FAILED' });
    if (config.auth.returnUrl === '') sendText(res, 400, `sso error: ${code}`);
    else redirect(res, returnTo(config.auth.returnUrl, `mperror=${encodeURIComponent(code)}`));
    return true;
  };

  const startFlow = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    provider: ProviderId,
    link?: { accountKey: string; accountName: string },
  ): Promise<boolean> => {
    const ip = clientIp(req);
    if (!limiter.allow(ip)) {
      metrics.rateLimited.inc({ budget: 'login' });
      return fail(res, 'rate', 'too many auth attempts from this address', ip);
    }
    if (!oidc.enabled(provider)) return fail(res, 'provider_disabled', `provider ${provider} is not enabled`, ip);
    let started;
    try {
      started = await oidc.start(provider, link);
    } catch (err) {
      // Discovery/JWKS reachability problems are the operator's, not the player's.
      log('error', 'auth.start_failed', { provider, error: String(err) });
      return fail(res, 'provider_unreachable', String(err), ip);
    }
    // The invite code is carried across the round trip so an invite-only server stays
    // invite-only through SSO (it is checked at account CREATION, in the callback).
    const invite = url.searchParams.get('invite');
    if (invite !== null) {
      const pending = oidc.peek(started.state);
      if (pending) pending.invite = invite.slice(0, 128);
    }
    setCookie(res, STATE_COOKIE, started.state, {
      maxAgeSec: STATE_COOKIE_MAX_AGE,
      path: COOKIE_PATH,
      secure: isSecureRequest(req),
    });
    redirect(res, started.url);
    return true;
  };

  const callback = async (req: IncomingMessage, res: ServerResponse, url: URL, provider: ProviderId): Promise<boolean> => {
    const ip = clientIp(req);
    const cookieState = readCookie(req, STATE_COOKIE);
    // Clear it whatever happens: a state cookie outliving its round trip is only useful
    // to an attacker replaying the callback.
    setCookie(res, STATE_COOKIE, '', { maxAgeSec: 0, path: COOKIE_PATH, secure: isSecureRequest(req) });

    const providerError = url.searchParams.get('error');
    if (providerError !== null) return fail(res, 'provider_refused', providerError.slice(0, 200), ip);
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code') ?? '';
    if (state === '' || code === '') return fail(res, 'bad_callback', 'callback is missing state or code', ip);
    if (cookieState === '') return fail(res, 'state', 'callback carried no state cookie', ip);

    let result;
    try {
      result = await oidc.callback(state, cookieState, code);
    } catch (err) {
      const code = err instanceof OidcError ? err.code : 'exchange';
      return fail(res, code, String(err), ip);
    }
    const { identity, pending } = result;
    if (pending.provider !== provider) return fail(res, 'state', 'state belongs to a different provider', ip);

    // ---- link: bind this identity to the account that started the flow.
    if (pending.linkAccountKey) {
      const existing = identities.get(identity.iss, identity.sub);
      if (existing && existing.accountKey !== pending.linkAccountKey)
        return fail(res, 'link_conflict', `identity already linked to ${existing.accountKey}`, ip);
      if (!existing) await identities.bind(identity.iss, identity.sub, pending.linkAccountKey);
      log('info', 'auth.linked', { provider, account: pending.linkAccountKey });
      metrics.auth.inc({ op: 'link', result: 'success' });
      if (config.auth.returnUrl === '') {
        sendText(res, 200, 'linked');
        return true;
      }
      redirect(res, returnTo(config.auth.returnUrl, `mplink=${encodeURIComponent(provider)}`));
      return true;
    }

    // ---- login: resolve (iss,sub) to an account, creating one on first sight.
    const known = identities.get(identity.iss, identity.sub);
    if (!known) {
      if (!config.login.allowRegistration)
        return fail(res, 'registration_disabled', 'this server does not accept new accounts', ip);
      if (config.login.inviteCode !== '' && pending.invite !== config.login.inviteCode)
        return fail(res, 'invite_required', 'this server is invite-only', ip);
    }
    let resolved;
    try {
      resolved = await resolveSsoAccount(accounts, identities, provider, identity);
    } catch (err) {
      log('error', 'auth.resolve_failed', { provider, error: String(err) });
      return fail(res, 'account', String(err), ip);
    }
    // Refused here as courtesy feedback; the authoritative ban check is on the RESOLVED
    // account at ticket redemption, in connection.ts.
    if (bans.isAccountBanned(resolved.accountKey) || (await accounts.get(resolved.accountKey))?.banned)
      return fail(res, 'banned', `banned account ${resolved.accountKey} attempted an SSO login`, ip);

    const ticket = tickets.mint(resolved.accountKey, resolved.accountName);
    // Locker session cookie: lets this browser reach /locker/* to upload its game data
    // before it joins any world. httpOnly + SameSite=Lax so JS cannot read it and it is
    // not sent cross-site; scoped to /locker.
    if (lockerSessions) {
      setCookie(res, 'omw_locker', lockerSessions.mint(resolved.accountKey), {
        maxAgeSec: 24 * 60 * 60, path: '/locker', secure: isSecureRequest(req),
      });
    }
    log('info', 'auth.sso_ok', { provider, account: resolved.accountName, created: resolved.created, ip });
    metrics.auth.inc({ op: 'sso', result: 'success' });
    if (config.auth.returnUrl === '') {
      // No return URL configured: hand the ticket over as text so a self-hoster can still
      // drive the flow by hand. Never reachable in a normal deployment (boot rejects it).
      sendText(res, 200, ticket);
      return true;
    }
    redirect(res, returnTo(config.auth.returnUrl, `mpticket=${encodeURIComponent(ticket)}`));
    return true;
  };

  return (req, res, url) => {
    const seg = url.pathname.split('/').filter((s) => s !== '');
    if (req.method !== 'GET' || seg[0] !== 'auth') return also ? also(req, res, url) : false;

    if (seg.length === 2 && seg[1] === 'providers') {
      // Public and cheap, like /status: a client cannot render login buttons without it.
      sendJson(res, 200, {
        providers: oidc.enabledProviders(),
        allowPasswordLogin: config.auth.allowPasswordLogin,
        allowRegistration: config.login.allowRegistration,
      });
      return true;
    }

    // /auth/link/:provider is matched before /auth/:provider/... because "link" is not a
    // provider id, so the two namespaces cannot collide.
    if (seg.length === 3 && seg[1] === 'link') {
      const provider = seg[2] ?? '';
      if (!isProviderId(provider)) return fail(res, 'unknown_provider', provider, clientIp(req));
      // The game session token proves who is asking. It arrives in the query because a
      // top-level browser navigation has nowhere else to put it; it is consumed here and
      // the very next thing the browser sees is a 302 to the provider, so it never becomes
      // the address of a page.
      const token = url.searchParams.get('session') ?? '';
      const who = sessions.get(token);
      if (!who) return fail(res, 'not_signed_in', 'link requires a live game session token', clientIp(req));
      return startFlow(req, res, url, provider, who);
    }

    if (seg.length === 3) {
      const provider = seg[1] ?? '';
      if (!isProviderId(provider)) return fail(res, 'unknown_provider', provider, clientIp(req));
      if (seg[2] === 'start') return startFlow(req, res, url, provider);
      if (seg[2] === 'callback') return callback(req, res, url, provider);
    }
    return also ? also(req, res, url) : false;
  };
}
