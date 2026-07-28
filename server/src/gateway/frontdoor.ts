// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// F3 — the gateway's front door: SSO (/auth/*) and the storage locker (/locker/*), served on
// the SAME public port as the world directory.
//
// WHY HERE AND NOT ON A WORLD. A browser signs in and uploads its game data BEFORE it knows
// which world it will join, so those endpoints cannot live on a per-world socket. They operate
// purely on the SHARED dir (accounts, SSO identities, the login-ticket files, the per-account
// locker) + config, with no world game state — so the gateway can construct them standalone.
//
// The SSO callback here mints a login ticket that a DIFFERENT world process claims: the ticket
// store is file-backed on the shared dir (LoginTicketStore(sharedDir)), so the ticket the front
// door writes is the ticket the world reads. Auth is still done again on the world's WebSocket
// — the ticket grants exactly one auth attempt there, nothing more.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig } from '../config';
import { AccountStore, validEmail } from '../core/accounts';
import { BanStore } from '../persist/banstore';
import { OidcService } from '../auth/oidc';
import { IdentityStore, LoginTicketStore, SessionIndex, LockerSessionStore } from '../auth/identities';
import { IpRateLimiter } from '../net/ratelimit';
import { createAuthRoutes } from '../auth/routes';
import { Locker, loadVanillaManifest } from '../data/locker';
import { s3FromEnv } from '../data/s3';
import { lockerRoutes } from '../data/locker-routes';
import type { HttpRoute } from '../net/http';
import { log } from '../log';

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let b = ''; for await (const c of req) { b += c; if (b.length > 8192) throw new Error('too large'); }
  return JSON.parse(b || '{}') as Record<string, unknown>;
}

// The onboarding profile: contact email (kept private, never on the wire) + the unique public
// handle shown to everyone. Done in the launcher (HTML) right after sign-in, so a fresh player
// picks a username instead of being shown their real name. Authed by the locker Bearer token.
function profileRoutes(accounts: AccountStore, lockerSessions: LockerSessionStore): HttpRoute {
  return async (req, res, url) => {
    if (url.pathname !== '/auth/profile') return false;
    res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    const auth = req.headers.authorization ?? '';
    const accountKey = lockerSessions.resolve(auth.startsWith('Bearer ') ? auth.slice(7) : '');
    if (!accountKey) { sendJson(res, 401, { error: 'sign_in_first' }); return true; }
    const account = await accounts.get(accountKey);
    if (!account) { sendJson(res, 404, { error: 'no_account' }); return true; }

    if (req.method === 'GET') {
      // needsProfile drives whether the launcher shows the onboarding step at all.
      sendJson(res, 200, {
        username: account.username ?? null,
        hasEmail: account.email !== undefined,
        needsProfile: account.username === undefined || account.email === undefined,
      });
      return true;
    }
    if (req.method === 'POST') {
      let body: Record<string, unknown>;
      try { body = await readBody(req); } catch { sendJson(res, 400, { error: 'bad_body' }); return true; }
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      // Email required only if not already on file (SSO does not give us one — profile scope only).
      if (account.email === undefined) {
        if (!validEmail(email)) { sendJson(res, 200, { ok: false, field: 'email', error: 'Enter a valid email address.' }); return true; }
        accounts.setEmail(account, email);
      }
      const r = await accounts.setUsername(account, username);
      if (r !== 'ok') {
        const msg: Record<string, string> = {
          badformat: '3-20 characters, letters and numbers only.',
          'reserved-word': 'That name is reserved — pick another.',
          taken: 'That username is already taken.',
          cooldown: 'You changed your username too recently.',
        };
        sendJson(res, 200, { ok: false, field: 'username', error: msg[r] ?? 'Invalid username.' });
        return true;
      }
      await accounts.flush(); // persist now, so the world reads the new handle when the player joins
      log('info', 'frontdoor.profile_set', { account: account.name, username: account.username });
      sendJson(res, 200, { ok: true, username: account.username });
      return true;
    }
    sendJson(res, 405, { error: 'method_not_allowed' });
    return true;
  };
}

export interface FrontDoor {
  // A single HttpRoute that handles /auth/* and /locker/*. Returns true when it claimed the
  // request; the directory handles everything else (/worlds, /healthz).
  route: HttpRoute;
}

// All state lives in the shared dir; the same files the world processes read and write.
export async function buildFrontDoor(sharedDir: string): Promise<FrontDoor> {
  const config = loadConfig(sharedDir, undefined, sharedDir);
  const accounts = new AccountStore(sharedDir);
  const bans = new BanStore(sharedDir);
  const identities = new IdentityStore(sharedDir);
  const tickets = new LoginTicketStore(15 * 60_000, sharedDir); // file-backed: claimed by a world
  const sessions = new SessionIndex();
  const oidc = new OidcService(config.auth);
  const lockerSessions = new LockerSessionStore(); // minted AND resolved here — no cross-process

  const storage = s3FromEnv({
    endpoint: config.locker.endpoint,
    region: config.locker.region,
    bucket: config.locker.bucket,
  });
  const locker = new Locker({
    dataDir: sharedDir,
    maxBytesPerAccount: config.locker.maxBytesPerAccount,
    ...(storage ? { storage } : {}),
  });
  locker.configureAccepted(await loadVanillaManifest(sharedDir), [], {
    acceptByNameAndSize: config.locker.acceptByNameAndSize,
  });

  const providers = ['google', 'discord', 'microsoft'].filter(
    (p) => (config.auth as unknown as Record<string, { enabled?: boolean }>)[p]?.enabled,
  );
  log('info', 'frontdoor.ready', { requireSso: config.auth.requireSso, providers, locker: locker.enabled });

  // `also` is tried after the SSO routes: locker (/locker/*) then profile (/auth/profile).
  const locker2 = lockerRoutes({ locker, sessions: lockerSessions });
  const profile = profileRoutes(accounts, lockerSessions);
  const also: HttpRoute = async (req, res, url) =>
    (await locker2(req, res, url)) || (await profile(req, res, url));
  const route = createAuthRoutes(
    { config, oidc, identities, tickets, sessions, lockerSessions, accounts, bans,
      limiter: new IpRateLimiter(config.limits.loginPerMinPerIp) },
    also,
  );
  return { route };
}
