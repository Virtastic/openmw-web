// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase B HTTP surface:
//   GET /auth/providers          -> which providers this server offers (client renders buttons)
//   GET /auth/:provider/start    -> 302 to the provider, PKCE + state + nonce minted here
//   GET /auth/:provider/callback -> server-side code exchange, then 302 back to the game
//   GET /auth/link/:provider     -> same round trip, but binds to the CALLER's account
//
// Everything lands back on the caller's origin with the result in the URL FRAGMENT
// (#mpticket=... / #mperror=... / #mplink=...). A fragment is never sent to a server, never
// written to an access log and never leaks through Referer — a query parameter would be
// all three, and this ticket is a credential.
//
// The return target is DERIVED from the origin the browser used, so one build serves any
// hostname without a per-deployment constant. A `return` parameter is honoured only when it
// is on that SAME origin, which is what stops this being an open redirector — the classic
// way an authorization code (or ticket) gets stolen. [auth].returnUrl, when set, pins the
// permitted origin instead; leave it empty to stay fully dynamic.

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
  /** When set, return=admin flows can mint dashboard sessions for role-holding accounts. */
  adminSessions?: import('./identities').AdminSessionStore;
  accounts: AccountStore;
  bans: BanStore;
  limiter: IpRateLimiter; // shares the operator's per-IP auth budget
}

/** Read a small JSON body. Capped hard: this is an unauthenticated endpoint. */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4096) return {};
    chunks.push(c as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; }
  catch { return {}; }
}

// Appends the outcome to the operator's return URL as a fragment, replacing any fragment
// the operator wrote there (a stale one would shadow ours).
function returnTo(returnUrl: string, fragment: string): string {
  const hash = returnUrl.indexOf('#');
  const base = hash === -1 ? returnUrl : returnUrl.slice(0, hash);
  return `${base}#${fragment}`;
}

// The origin the browser actually used to reach us. X-Forwarded-Proto is already trusted to
// decide Secure-cookie flags (isSecureRequest), so the same proxy trust boundary applies.
function requestOrigin(req: IncomingMessage): string {
  const raw = req.headers.host;
  const host = (Array.isArray(raw) ? raw[0] : raw) ?? '';
  if (host === '') return '';
  return `${isSecureRequest(req) ? 'https' : 'http'}://${host}`;
}

// Where sign-in comes back to, DERIVED rather than configured: one build then serves any
// origin — production, a dev preview, a self-host — with no per-deployment constant to get
// wrong. A stale constant here is invisible from the client and only shows up as a redirect
// to somebody else's machine, which is exactly how this bit us.
//
// The open-redirect guard is that a requested return must be on the SAME origin the browser
// used to reach us, so a crafted ?return= can only ever point back at this site. When
// [auth].returnUrl IS set it pins the permitted origin instead of the request's — for a
// deployment fronted by several names that wants exactly one of them. Query and fragment are
// dropped: the launcher builds the game URL itself, and a ticket must never land in a query.
function resolveReturn(configured: string, req: IncomingMessage, requested: string | null): string {
  const origin = requestOrigin(req);
  let allowed = origin;
  if (configured !== '') {
    try { allowed = new URL(configured).origin; } catch { allowed = origin; }
  }
  if (requested !== null && requested !== '') {
    try {
      const u = new URL(requested, origin || undefined);
      if (u.origin === allowed && (u.protocol === 'https:' || u.protocol === 'http:')) {
        return `${u.origin}${u.pathname}`;
      }
    } catch { /* fall through to the default below */ }
  }
  if (configured !== '') return configured;
  // "/" and not "/launcher.html". The launcher is a chooser for the hosted site; a
  // self-hosted server's front door is its own sign-in page, and that is where a round trip
  // started there has to come back to. [auth].returnUrl still overrides for deployments
  // that front the game somewhere else.
  return origin === '' ? '' : `${origin}/`;
}

// `also` is chained AFTER the SSO routes: createHttpServer takes exactly one extra-route
// hook, and threading a list through it would touch every caller for one composition.
export function createAuthRoutes(deps: AuthDeps, also?: HttpRoute): HttpRoute {
  const { config, oidc, identities, tickets, sessions, lockerSessions, accounts, bans, limiter } = deps;

  // A failure the player caused (or a provider refused) goes back to the game page as a
  // machine-readable code; the human-readable reason stays in the server log. Nothing the
  // provider wrote is ever reflected into the response.
  const fail = (req: IncomingMessage, res: ServerResponse, code: string, detail: string, ip: string): true => {
    log('warn', 'auth.sso_failed', { code, detail, ip });
    metrics.auth.inc({ op: 'sso', result: 'AUTH_FAILED' });
    const back = resolveReturn(config.auth.returnUrl, req, null);
    if (back === '') sendText(res, 400, `sso error: ${code}`);
    else redirect(res, returnTo(back, `mperror=${encodeURIComponent(code)}`));
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
      return fail(req, res, 'rate', 'too many auth attempts from this address', ip);
    }
    if (!oidc.enabled(provider)) return fail(req, res, 'provider_disabled', `provider ${provider} is not enabled`, ip);
    let started;
    try {
      started = await oidc.start(provider, link);
    } catch (err) {
      // Discovery/JWKS reachability problems are the operator's, not the player's.
      log('error', 'auth.start_failed', { provider, error: String(err) });
      return fail(req, res, 'provider_unreachable', String(err), ip);
    }
    // Resolve the return target HERE, while we still have the browser's own request: the
    // callback arrives from the provider, so its Host is ours but the caller's intent is
    // gone. Carried on the pending state, which is server-side and keyed by `state`.
    const pending = oidc.peek(started.state);
    if (pending) {
      // return=admin flags the round trip as a DASHBOARD sign-in: the callback mints an
      // admin session instead of a game ticket, and lands back on /admin. This is decision
      // #1 made real — password and SSO side by side on the admin login, not either/or.
      if (url.searchParams.get('return') === 'admin') {
        pending.adminMode = true;
        const origin = requestOrigin(req);
        pending.returnUrl = origin === '' ? '' : `${origin}/admin`;
      } else {
        pending.returnUrl = resolveReturn(config.auth.returnUrl, req, url.searchParams.get('return'));
      }
      // The invite code is carried across the round trip so an invite-only server stays
      // invite-only through SSO (it is checked at account CREATION, in the callback).
      const invite = url.searchParams.get('invite');
      if (invite !== null) pending.invite = invite.slice(0, 128);
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
    if (providerError !== null) return fail(req, res, 'provider_refused', providerError.slice(0, 200), ip);
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code') ?? '';
    if (state === '' || code === '') return fail(req, res, 'bad_callback', 'callback is missing state or code', ip);
    if (cookieState === '') return fail(req, res, 'state', 'callback carried no state cookie', ip);

    let result;
    try {
      result = await oidc.callback(state, cookieState, code);
    } catch (err) {
      const code = err instanceof OidcError ? err.code : 'exchange';
      return fail(req, res, code, String(err), ip);
    }
    const { identity, pending } = result;
    if (pending.provider !== provider) return fail(req, res, 'state', 'state belongs to a different provider', ip);

    // ---- link: bind this identity to the account that started the flow.
    if (pending.linkAccountKey) {
      const existing = identities.get(identity.iss, identity.sub);
      if (existing && existing.accountKey !== pending.linkAccountKey)
        return fail(req, res, 'link_conflict', `identity already linked to ${existing.accountKey}`, ip);
      if (!existing) await identities.bind(identity.iss, identity.sub, pending.linkAccountKey);
      log('info', 'auth.linked', { provider, account: pending.linkAccountKey });
      metrics.auth.inc({ op: 'link', result: 'success' });
      const back = pending.returnUrl ?? resolveReturn(config.auth.returnUrl, req, null);
      if (back === '') {
        sendText(res, 200, 'linked');
        return true;
      }
      redirect(res, returnTo(back, `mplink=${encodeURIComponent(provider)}`));
      return true;
    }

    // ---- login: resolve (iss,sub) to an account, creating one on first sight.
    const known = identities.get(identity.iss, identity.sub);
    if (!known) {
      if (!config.login.allowRegistration)
        return fail(req, res, 'registration_disabled', 'this server does not accept new accounts', ip);
      if (config.login.inviteCode !== '' && pending.invite !== config.login.inviteCode)
        return fail(req, res, 'invite_required', 'this server is invite-only', ip);
    }
    let resolved;
    try {
      resolved = await resolveSsoAccount(accounts, identities, provider, identity);
    } catch (err) {
      log('error', 'auth.resolve_failed', { provider, error: String(err) });
      return fail(req, res, 'account', String(err), ip);
    }
    // Refused here as courtesy feedback; the authoritative ban check is on the RESOLVED
    // account at ticket redemption, in connection.ts.
    if (bans.isAccountBanned(resolved.accountKey) || (await accounts.get(resolved.accountKey))?.banned)
      return fail(req, res, 'banned', `banned account ${resolved.accountKey} attempted an SSO login`, ip);

    // ---- dashboard sign-in: an admin session, not a game ticket.
    if (pending.adminMode) {
      const account = await accounts.get(resolved.accountKey);
      const back = pending.returnUrl ?? '';
      if (!account?.dashboardRole || !deps.adminSessions) {
        // A real account with no dashboard access: not an attack, just someone who plays
        // here clicking the admin sign-in. Land them on the login page with the reason.
        log('warn', 'auth.admin_sso_no_role', { provider, account: resolved.accountKey, ip });
        if (back === '') { sendText(res, 403, 'this account has no dashboard access'); return true; }
        redirect(res, returnTo(back, 'ssoerr=no_access'));
        return true;
      }
      // TOTP is deliberately not demanded on this path: the identity provider is already a
      // second factor, and stacking ours on top would make SSO strictly worse than password.
      const adminToken = deps.adminSessions.mint(resolved.accountKey, ip);
      log('warn', 'admin.sso_login', { provider, account: resolved.accountKey, ip });
      metrics.auth.inc({ op: 'sso', result: 'success' });
      if (back === '') { sendText(res, 200, adminToken); return true; }
      redirect(res, returnTo(back, `t=${encodeURIComponent(adminToken)}`));
      return true;
    }

    const ticket = tickets.mint(resolved.accountKey, resolved.accountName);
    // Locker session token: lets this browser reach /locker/* to upload its game data
    // before it joins any world. Delivered in the return FRAGMENT alongside the game
    // ticket (never a query param — fragments are not logged/cached/Referer'd), because the
    // game page is a different origin and a cookie could not be sent on its cross-origin
    // fetch. The browser reads it and sends it as a Bearer header.
    const lockerToken = lockerSessions ? lockerSessions.mint(resolved.accountKey) : '';
    log('info', 'auth.sso_ok', { provider, account: resolved.accountName, created: resolved.created, ip });
    metrics.auth.inc({ op: 'sso', result: 'success' });
    // Target resolved at /auth/start from the caller's own origin (see resolveReturn).
    const back = pending.returnUrl ?? resolveReturn(config.auth.returnUrl, req, null);
    if (back === '') {
      // Nowhere to send them: no configured URL and no usable Host on the request. Hand the
      // ticket over as text so a self-hoster can still drive the flow by hand.
      sendText(res, 200, ticket);
      return true;
    }
    // mpaccount (the (iss,sub) account key) lets the launcher pick THIS player's private world
    // via the directory without a second round trip. It is the SSO identity key, not a secret,
    // and the world's ticket auth is the real gate — a wrong value just makes an unjoinable world.
    redirect(res, returnTo(back,
      `mpticket=${encodeURIComponent(ticket)}`
      + (lockerToken ? `&mplocker=${encodeURIComponent(lockerToken)}` : '')
      + `&mpaccount=${encodeURIComponent(resolved.accountKey)}`));
    return true;
  };

  return async (req, res, url) => {
    const seg = url.pathname.split('/').filter((s) => s !== '');
    if (seg[0] !== 'auth') return also ? also(req, res, url) : false;

    // PASSWORD SIGN-IN INTO THE GAME.
    //
    // Tickets could only be minted by the SSO callback, or reissued at /auth/ticket to
    // somebody who already held a locker session, which itself only came from SSO. So a
    // server with [auth].allowPasswordLogin on offered players a sign-in method that no
    // client could complete: the setup wizard listed it, the account existed, and there was
    // no route from a password to a ticket.
    //
    // Same checks as the SSO path, in the same order: the shared per-IP budget first, then
    // the account, then the ban. verifyLogin burns argon2 work on a missing account too (see
    // accounts.ts), so this cannot be used to learn which names exist by timing it.
    if (seg.length === 2 && seg[1] === 'password') {
      res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return true; }
      const ip = clientIp(req);
      if (!limiter.allow(ip)) {
        metrics.rateLimited.inc({ budget: 'login' });
        sendJson(res, 429, { error: 'too many attempts, wait a minute' });
        return true;
      }
      if (!config.auth.allowPasswordLogin) {
        sendJson(res, 403, { error: 'this server does not accept password sign-in' });
        return true;
      }
      const body = await readBody(req);
      const name = String(body.name ?? '').trim();
      const password = String(body.password ?? '');
      const account = await accounts.verifyLogin(name, password) ? await accounts.get(name) : undefined;
      if (!account) {
        log('warn', 'auth.password_failed', { ip });
        metrics.auth.inc({ op: 'password', result: 'AUTH_FAILED' });
        // One message for a wrong name and a wrong password: telling them apart is an
        // account-enumeration oracle.
        sendJson(res, 401, { error: 'that name and password do not match' });
        return true;
      }
      const key = name.toLowerCase();
      if (bans.isAccountBanned(key) || account.banned) {
        log('warn', 'auth.password_banned', { account: key, ip });
        sendJson(res, 403, { error: 'this account is banned' });
        return true;
      }
      const ticket = tickets.mint(key, account.name);
      const locker = lockerSessions ? lockerSessions.mint(key) : '';
      log('info', 'auth.password_ok', { account: account.name, ip });
      metrics.auth.inc({ op: 'password', result: 'success' });
      sendJson(res, 200, { ticket, account: key, name: account.name, locker });
      return true;
    }

    if (req.method !== 'GET') return also ? also(req, res, url) : false;

    if (seg.length === 2 && seg[1] === 'providers') {
      // Public and cheap, like /status: a client cannot render login buttons without it.
      // CORS-open: the launcher is served from a different origin than the game server.
      res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
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
      if (!isProviderId(provider)) return fail(req, res, 'unknown_provider', provider, clientIp(req));
      // The game session token proves who is asking. It arrives in the query because a
      // top-level browser navigation has nowhere else to put it; it is consumed here and
      // the very next thing the browser sees is a 302 to the provider, so it never becomes
      // the address of a page.
      const token = url.searchParams.get('session') ?? '';
      const who = sessions.get(token);
      if (!who) return fail(req, res, 'not_signed_in', 'link requires a live game session token', clientIp(req));
      return startFlow(req, res, url, provider, who);
    }

    if (seg.length === 3) {
      const provider = seg[1] ?? '';
      if (!isProviderId(provider)) return fail(req, res, 'unknown_provider', provider, clientIp(req));
      if (seg[2] === 'start') return startFlow(req, res, url, provider);
      if (seg[2] === 'callback') return callback(req, res, url, provider);
    }
    return also ? also(req, res, url) : false;
  };
}

// Exposed for the open-redirect tests. resolveReturn is the whole security boundary for
// a derived return target, so it is worth exercising directly rather than through a
// full OAuth round trip.
export const __testing = { resolveReturn, requestOrigin };
