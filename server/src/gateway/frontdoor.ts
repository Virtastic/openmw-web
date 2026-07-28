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

import { loadConfig } from '../config';
import { AccountStore } from '../core/accounts';
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

  const route = createAuthRoutes(
    { config, oidc, identities, tickets, sessions, lockerSessions, accounts, bans,
      limiter: new IpRateLimiter(config.limits.loginPerMinPerIp) },
    lockerRoutes({ locker, sessions: lockerSessions }),
  );
  return { route };
}
