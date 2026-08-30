// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase B SSO: OAuth 2.0 Authorization Code + PKCE (S256) against Discord/Google/
// Microsoft (or any OIDC issuer via [auth.custom]).
//
// WHY this shape, and not the obvious alternatives:
//   * Authorization Code + PKCE, never implicit. RFC 9700 §2.1.2 deprecates implicit
//     (tokens land in the URL fragment -> history, Referer, extensions, and cannot be
//     sender-constrained); PKCE is a MUST for browser-based public clients
//     (draft-ietf-oauth-browser-based-apps §6.3.2.1).
//   * This relay is a Backend-For-Frontend: the code->token exchange happens HERE, with
//     the client secret, and the provider's access/refresh/id tokens NEVER reach the
//     browser and never enter the WS protocol. Google forces this anyway (its "web"
//     clients carry a client_secret), and it is what keeps a stolen browser tab from
//     being a stolen Google session.
//   * Identity is keyed on (iss, sub). Email is mutable and providers re-assign it;
//     `sub` is the only identifier guaranteed stable, and only within one issuer. We do
//     not even REQUEST an email scope.
//
// No new dependency: node:crypto verifies RS256 straight from a JWK, and fetch is built in.

import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as verifySig } from 'node:crypto';
import type { AuthConfig, AuthProviderConfig } from '../config';
import { log } from '../log';

export type ProviderId = 'discord' | 'google' | 'microsoft' | 'custom';
export const PROVIDER_IDS: readonly ProviderId[] = ['discord', 'google', 'microsoft', 'custom'];

export function isProviderId(s: string): s is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(s);
}

// A verified identity. `nameHint` is only ever a *display* name claim — never shown as, or
// confused with, the email (see pickDisplayName() in identities.ts). `email` is present only
// when the provider returned a VERIFIED address for the requested email scope; it is stored as
// contact info on the account and never appears on any peer-visible surface.
export interface Identity {
  iss: string;
  sub: string;
  nameHint?: string;
  email?: string;
}

export class OidcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OidcError';
  }
}

interface ProviderDefaults {
  kind: 'oidc' | 'oauth2';
  issuer: string;
  scope: string;
  // oauth2 (Discord) has no discovery and no ID token: endpoints are fixed and identity
  // comes from a userinfo call over the access token.
  authorizeUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
}

// Discord is OAuth 2.0, NOT OpenID Connect — it issues no ID token. Pretending otherwise
// (a fake issuer, a "verified" claim set) would hide that its identity assertion is a
// plain API read, so it is handled as its own kind. `iss` below is OUR namespace label
// for Discord subjects; it never has to match anything Discord sends, but it must never
// change, because it is half of every stored identity key.
const DEFAULTS: Record<ProviderId, ProviderDefaults> = {
  discord: {
    kind: 'oauth2',
    issuer: 'https://discord.com',
    scope: 'identify email',
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    userinfoUrl: 'https://discord.com/api/users/@me',
  },
  // We still KEY on sub (never email), but request the email scope so the account's contact
  // email can be captured at login and the onboarding email step skipped. Only a provider-
  // VERIFIED address is used (email_verified / Discord `verified`).
  google: { kind: 'oidc', issuer: 'https://accounts.google.com', scope: 'openid profile email' },
  // The common endpoint's discovery issuer is templated per tenant; see matchIssuer().
  microsoft: { kind: 'oidc', issuer: 'https://login.microsoftonline.com/common/v2.0', scope: 'openid profile email' },
  custom: { kind: 'oidc', issuer: '', scope: 'openid profile email' },
};

interface Endpoints {
  issuer: string; // may contain {tenantid}
  authorizeUrl: string;
  tokenUrl: string;
  jwksUri?: string;
  userinfoUrl?: string;
}

interface Jwk {
  kty?: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 60 * 1000; // bound on kid-miss refetches (a DoS lever otherwise)
const FETCH_TIMEOUT_MS = 10_000;
const CLOCK_SKEW_SEC = 120;
const PENDING_TTL_MS = 10 * 60 * 1000; // an authorization round trip that takes >10 min is dead
const MAX_PENDING = 10_000; // bounded: /auth/start is unauthenticated

// A leg of an authorization round trip, held server-side and keyed by `state`. The
// verifier NEVER leaves this process — that is the entire point of PKCE.
export interface Pending {
  provider: ProviderId;
  verifier: string;
  nonce: string;
  createdAt: number;
  linkAccountKey?: string; // set by /auth/link/:provider — bind, do not log in
  linkAccountName?: string;
  invite?: string; // [login].inviteCode carried across the round trip
  // This round trip signs in to the ADMIN DASHBOARD, not the game: the callback mints an
  // admin session (for an account that holds a dashboard role) instead of a game ticket.
  adminMode?: boolean;
  // Where to send the browser when this round trip finishes. Resolved at /auth/start from
  // the origin the browser actually used, so one build serves any hostname; carried here
  // because the callback arrives from the provider and cannot re-derive the caller's intent.
  returnUrl?: string;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new OidcError('network', `${url}: ${String(err)}`);
  }
  const text = await res.text();
  if (!res.ok) throw new OidcError('http', `${url}: ${res.status} ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OidcError('bad_json', `${url}: response was not JSON`);
  }
}

function str(o: unknown, key: string): string | undefined {
  if (typeof o !== 'object' || o === null) return undefined;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// Constant-time string compare for the pieces an attacker can guess at (state, nonce).
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class OidcService {
  private readonly pending = new Map<string, Pending>();
  private readonly discovery = new Map<ProviderId, { at: number; endpoints: Endpoints }>();
  private readonly jwks = new Map<string, { at: number; keys: Jwk[] }>(); // key = jwks uri
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(private readonly cfg: AuthConfig) {
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref();
  }

  close(): void {
    clearInterval(this.sweepTimer);
    this.pending.clear();
  }

  private sweep(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [state, p] of this.pending) if (p.createdAt < cutoff) this.pending.delete(state);
  }

  providerConfig(id: ProviderId): AuthProviderConfig {
    return this.cfg[id];
  }

  // A provider is usable only when fully configured — a half-filled table is an operator
  // mistake we must not paper over by redirecting to a broken authorize URL.
  enabled(id: ProviderId): boolean {
    const p = this.cfg[id];
    if (!p.enabled) return false;
    if (p.clientId === '' || p.clientSecret === '' || p.redirectUri === '') return false;
    if (id === 'custom' && p.issuer === '') return false;
    return true;
  }

  enabledProviders(): ProviderId[] {
    return PROVIDER_IDS.filter((id) => this.enabled(id));
  }

  private async endpoints(id: ProviderId): Promise<Endpoints> {
    const cached = this.discovery.get(id);
    if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.endpoints;
    const d = DEFAULTS[id];
    const cfgIssuer = this.cfg[id].issuer;
    let endpoints: Endpoints;
    if (d.kind === 'oauth2') {
      endpoints = {
        issuer: cfgIssuer || d.issuer,
        authorizeUrl: d.authorizeUrl!,
        tokenUrl: d.tokenUrl!,
        userinfoUrl: d.userinfoUrl!,
      };
    } else {
      // OIDC discovery. The issuer an operator configures wins, so a self-hoster (or the
      // test suite) can point `custom` at their own IdP.
      const base = (cfgIssuer || d.issuer).replace(/\/+$/, '');
      const doc = await fetchJson(`${base}/.well-known/openid-configuration`);
      const issuer = str(doc, 'issuer');
      const authorizeUrl = str(doc, 'authorization_endpoint');
      const tokenUrl = str(doc, 'token_endpoint');
      const jwksUri = str(doc, 'jwks_uri');
      if (!issuer || !authorizeUrl || !tokenUrl || !jwksUri)
        throw new OidcError('discovery', `${base}: discovery document is missing required endpoints`);
      endpoints = { issuer, authorizeUrl, tokenUrl, jwksUri };
    }
    this.discovery.set(id, { at: Date.now(), endpoints });
    return endpoints;
  }

  private async keys(uri: string, allowRefetch: boolean): Promise<Jwk[]> {
    const cached = this.jwks.get(uri);
    const age = cached ? Date.now() - cached.at : Infinity;
    if (cached && age < JWKS_TTL_MS && !(allowRefetch && age > JWKS_MIN_REFETCH_MS)) return cached.keys;
    const doc = await fetchJson(uri);
    const raw = (doc as { keys?: unknown }).keys;
    if (!Array.isArray(raw)) throw new OidcError('jwks', `${uri}: no "keys" array`);
    const keys = raw.filter((k): k is Jwk => typeof k === 'object' && k !== null);
    this.jwks.set(uri, { at: Date.now(), keys });
    return keys;
  }

  // ------------------------------------------------------------------- start

  // Returns the provider authorize URL plus the opaque state to park in a cookie. The
  // caller sets the cookie; the callback requires BOTH the server-side entry and a
  // matching cookie, so a pasted callback URL cannot log the victim into the attacker's
  // account (login CSRF).
  async start(id: ProviderId, link?: { accountKey: string; accountName: string }): Promise<{ url: string; state: string }> {
    if (!this.enabled(id)) throw new OidcError('disabled', `provider ${id} is not enabled`);
    if (this.pending.size >= MAX_PENDING) {
      this.sweep();
      if (this.pending.size >= MAX_PENDING) throw new OidcError('busy', 'too many authorization requests in flight');
    }
    const p = this.cfg[id];
    const ep = await this.endpoints(id);
    const verifier = b64url(randomBytes(32)); // 43 chars, the RFC 7636 floor is 43
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(16));
    this.pending.set(state, {
      provider: id,
      verifier,
      nonce,
      createdAt: Date.now(),
      ...(link ? { linkAccountKey: link.accountKey, linkAccountName: link.accountName } : {}),
    });
    const url = new URL(ep.authorizeUrl);
    url.searchParams.set('response_type', 'code'); // never "token"/"id_token": RFC 9700 §2.1.2
    url.searchParams.set('client_id', p.clientId);
    url.searchParams.set('redirect_uri', p.redirectUri);
    url.searchParams.set('scope', p.scope || DEFAULTS[id].scope);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256'); // never "plain"
    if (DEFAULTS[id].kind === 'oidc') url.searchParams.set('nonce', nonce);
    if (id === 'discord') url.searchParams.set('prompt', 'none'); // skip re-consent on every login
    return { url: url.toString(), state };
  }

  // ---------------------------------------------------------------- callback

  peek(state: string): Pending | undefined {
    return this.pending.get(state);
  }

  // Single use: a code may only ever be redeemed once, so the state that carries its
  // verifier dies with it — replaying a callback URL must not work.
  private claim(state: string, cookieState: string): Pending {
    const p = this.pending.get(state);
    if (!p) throw new OidcError('state', 'unknown or expired state');
    this.pending.delete(state);
    if (Date.now() - p.createdAt > PENDING_TTL_MS) throw new OidcError('state', 'authorization request expired');
    if (!safeEqual(state, cookieState)) throw new OidcError('state', 'state does not match the browser cookie');
    return p;
  }

  // Exchanges the code SERVER-SIDE and returns the verified identity. Throws OidcError on
  // every rejection path; the caller renders a plain error, never the provider's text.
  async callback(state: string, cookieState: string, code: string): Promise<{ identity: Identity; pending: Pending }> {
    const pending = this.claim(state, cookieState);
    const id = pending.provider;
    if (!this.enabled(id)) throw new OidcError('disabled', `provider ${id} is no longer enabled`);
    const p = this.cfg[id];
    const ep = await this.endpoints(id);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: p.redirectUri,
      client_id: p.clientId,
      client_secret: p.clientSecret, // BFF: the secret lives here, never in the browser
      code_verifier: pending.verifier,
    });
    const token = await fetchJson(ep.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });

    if (DEFAULTS[id].kind === 'oauth2') {
      const accessToken = str(token, 'access_token');
      if (!accessToken) throw new OidcError('token', 'token response carried no access_token');
      const me = await fetchJson(ep.userinfoUrl!, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      });
      const sub = str(me, 'id');
      if (!sub) throw new OidcError('userinfo', 'userinfo carried no id');
      // global_name/username are display handles. Discord's email is captured only when the
      // account marks it verified.
      const nameHint = str(me, 'global_name') ?? str(me, 'username');
      const email = (me as Record<string, unknown>).verified === true ? str(me, 'email') : undefined;
      return {
        identity: { iss: ep.issuer, sub, ...(nameHint ? { nameHint } : {}), ...(email ? { email } : {}) },
        pending,
      };
    }

    const idToken = str(token, 'id_token');
    if (!idToken) throw new OidcError('token', 'token response carried no id_token');
    const claims = await this.verifyIdToken(idToken, ep, p, pending.nonce);
    const sub = str(claims, 'sub');
    const iss = str(claims, 'iss');
    if (!sub || !iss) throw new OidcError('idtoken', 'id_token has no sub/iss');
    const nameHint = str(claims, 'preferred_username') ?? str(claims, 'name') ?? str(claims, 'given_name');
    // Capture the email only when the provider asserts it is verified (Google/Microsoft send
    // email_verified as a boolean, some IdPs as the string "true"). An unverified address is
    // not trustworthy as contact data, so we drop it and onboarding still asks.
    const verified = (claims as Record<string, unknown>).email_verified;
    const emailClaim = str(claims, 'email');
    const email = emailClaim && (verified === true || verified === 'true') ? emailClaim : undefined;
    return { identity: { iss, sub, ...(nameHint ? { nameHint } : {}), ...(email ? { email } : {}) }, pending };
  }

  // ------------------------------------------------------------- id_token

  // Microsoft's /common discovery advertises a templated issuer; the real one is per
  // tenant. Anything else must match exactly.
  private issuerMatches(want: string, got: string): boolean {
    if (want === got) return true;
    if (!want.includes('{tenantid}')) return false;
    const re = new RegExp(`^${want.split('{tenantid}').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[0-9a-fA-F-]{36}')}$`);
    return re.test(got);
  }

  private async verifyIdToken(
    jwt: string,
    ep: Endpoints,
    p: AuthProviderConfig,
    nonce: string,
  ): Promise<Record<string, unknown>> {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new OidcError('idtoken', 'id_token is not a JWS compact serialization');
    const [h, c, s] = parts as [string, string, string];
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as Record<string, unknown>;
      claims = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new OidcError('idtoken', 'id_token header/payload is not JSON');
    }
    // RS256 only. `alg: none` and HMAC confusion are the classic JWT forgeries; an
    // allowlist of one is the cleanest defence, and all three providers sign RS256.
    if (header['alg'] !== 'RS256') throw new OidcError('idtoken', `unsupported id_token alg ${String(header['alg'])}`);
    const kid = typeof header['kid'] === 'string' ? header['kid'] : undefined;
    if (!ep.jwksUri) throw new OidcError('idtoken', 'provider has no jwks_uri');

    const signed = Buffer.from(`${h}.${c}`, 'utf8');
    const sig = Buffer.from(s, 'base64url');
    let ok = false;
    for (const allowRefetch of [false, true]) {
      const keys = await this.keys(ep.jwksUri, allowRefetch);
      const candidates = keys.filter(
        (k) => k.kty === 'RSA' && (kid === undefined || k.kid === undefined || k.kid === kid) && (k.use ?? 'sig') === 'sig',
      );
      for (const jwk of candidates) {
        let key;
        try {
          key = createPublicKey({ key: jwk as Record<string, unknown>, format: 'jwk' });
        } catch (err) {
          log('warn', 'oidc.bad_jwk', { jwks: ep.jwksUri, kid: jwk.kid ?? null, error: String(err) });
          continue;
        }
        if (verifySig('sha256', signed, key, sig)) {
          ok = true;
          break;
        }
      }
      if (ok) break;
      // A signing key we have never seen is normal (providers roll keys); one refetch,
      // rate-limited, then give up.
      if (allowRefetch) break;
    }
    if (!ok) throw new OidcError('idtoken', 'id_token signature does not verify against the provider JWKS');

    const iss = str(claims, 'iss');
    if (!iss || !this.issuerMatches(ep.issuer, iss)) throw new OidcError('idtoken', `id_token iss mismatch: ${String(iss)}`);
    const aud = claims['aud'];
    const audOk = typeof aud === 'string' ? aud === p.clientId : Array.isArray(aud) && aud.includes(p.clientId);
    if (!audOk) throw new OidcError('idtoken', 'id_token aud is not this client');
    const now = Math.floor(Date.now() / 1000);
    const exp = claims['exp'];
    if (typeof exp !== 'number' || now > exp + CLOCK_SKEW_SEC) throw new OidcError('idtoken', 'id_token is expired');
    const nbf = claims['nbf'];
    if (typeof nbf === 'number' && now < nbf - CLOCK_SKEW_SEC) throw new OidcError('idtoken', 'id_token is not yet valid');
    const iat = claims['iat'];
    if (typeof iat === 'number' && now < iat - CLOCK_SKEW_SEC) throw new OidcError('idtoken', 'id_token iat is in the future');
    const gotNonce = str(claims, 'nonce');
    // The nonce binds this id_token to the authorization request WE started; without it a
    // token minted for another session of the same client would be accepted.
    if (!gotNonce || !safeEqual(gotNonce, nonce)) throw new OidcError('idtoken', 'id_token nonce mismatch');
    return claims;
  }
}
