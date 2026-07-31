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
import { detectGameData, gameDataDir } from '../core/gamedata';
import { loadConfig } from '../config';
import { AccountStore, validEmail, validAccountName, MAX_CHARACTERS } from '../core/accounts';
import { PlayerStore } from '../persist/playerstore';
import { BanStore } from '../persist/banstore';
import { OidcService } from '../auth/oidc';
import { IdentityStore, LoginTicketStore, SessionIndex, LockerSessionStore } from '../auth/identities';
import { IpRateLimiter } from '../net/ratelimit';
import { createAuthRoutes } from '../auth/routes';
import { Locker, loadVanillaManifest } from '../data/locker';
import { ensureVanillaManifest } from '../data/vanilla-manifest';
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

// Character slots over HTTP, so the launcher's pre-boot tile screen can list + create
// characters before any world exists. Same Bearer-locker-token auth as the profile route.
// GET returns each slot enriched with its level (read from the SHARED PlayerStore doc — the
// slot record itself carries no stats). POST creates a slot from an alias.
export function characterRoutes(
  accounts: AccountStore,
  lockerSessions: LockerSessionStore,
  players: PlayerStore,
  // Deleting a character must also retire its solo world: the world id is derived from the
  // character, so once the character is gone nothing can ever reach that world again.
  onCharacterDeleted?: (owner: { accountKey: string; username?: string }, charId: string) => void,
): HttpRoute {
  return async (req, res, url) => {
    if (url.pathname !== '/auth/characters') return false;
    res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    const auth = req.headers.authorization ?? '';
    const accountKey = lockerSessions.resolve(auth.startsWith('Bearer ') ? auth.slice(7) : '');
    if (!accountKey) { sendJson(res, 401, { error: 'sign_in_first' }); return true; }
    const account = await accounts.get(accountKey);
    if (!account) { sendJson(res, 404, { error: 'no_account' }); return true; }

    if (req.method === 'DELETE') {
      // Permanent, and the id must belong to THIS account (deleteCharacter enforces that —
      // never trust a client-supplied character id). The slot goes first, then the saved
      // doc: a crash between the two leaves an orphan doc rather than a slot pointing at
      // nothing, which is the harmless direction to fail in.
      const id = url.searchParams.get('id') ?? '';
      if (!accounts.deleteCharacter(account, id)) { sendJson(res, 200, { ok: false, error: 'No such character.' }); return true; }
      await accounts.flush();
      await players.erase(id);
      onCharacterDeleted?.(
        { accountKey: account.name.toLowerCase(), ...(account.username ? { username: account.username } : {}) }, id);
      log('info', 'frontdoor.character_deleted', { account: account.name, character: id });
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (req.method === 'GET') {
      const chars = account.characters ?? [];
      // Level lives in the character's shared PlayerDoc, not on the slot. A brand-new slot
      // (never played, no chargen yet) has no doc — report level 1.
      const withLevel = await Promise.all(chars.map(async (c) => {
        const doc = await players.get(c.id);
        // The name the player typed in Morrowind's own character creation wins over the slot
        // label: it is what they actually called themselves, so the tile screen never has to
        // ask for an alias up front.
        return { id: c.id, name: doc?.appearance?.name || c.name,
          createdAt: c.createdAt, lastPlayedAt: c.lastPlayedAt,
          level: doc?.stats?.level ?? 1,
          // A slot needs chargen until creation FINISHED (the completed flag, reported by the
          // client at CharGenState == -1). doc.appearance grandfathers pre-flag characters.
          // An abandoned creation therefore boots back INTO chargen (the world wipes its
          // partial doc at auth), never into a half-made character.
          needsChargen: c.completed !== true && doc?.appearance === undefined,
          // Per-world saved positions, so the launcher can boot the engine STRAIGHT into the
          // cell the character logged out in. Without it the engine spawns at the game's
          // default start and the server teleports afterwards — which means real seconds
          // standing somewhere you did not choose, next to whatever lives there.
          // Raw map, not doc.position: this store has no world id, so position is not
          // materialised here and only the caller knows which world it is about to open.
          positions: doc?.positions ?? {} };
      }));
      sendJson(res, 200, { characters: withLevel, max: MAX_CHARACTERS });
      return true;
    }
    if (req.method === 'POST') {
      let body: Record<string, unknown>;
      try { body = await readBody(req); } catch { sendJson(res, 400, { error: 'bad_body' }); return true; }
      // No alias needed: the real name comes from Morrowind's character creation and replaces
      // this provisional label on the next listing (see GET above). An explicit alias is still
      // accepted for callers that want one.
      const alias = typeof body.alias === 'string' ? body.alias.trim() : '';
      const label = alias === '' ? 'New character' : alias;
      if (!validAccountName(label)) {
        sendJson(res, 200, { ok: false, error: '2-24 characters: letters, numbers, spaces, - or _.' });
        return true;
      }
      // Hand back an id WITHOUT writing a slot. The character starts existing when creation
      // finishes (ChargenComplete -> adoptCharacter in the world), so quitting during
      // Morrowind's opening leaves no tile, no row and no doc — there is nothing to hide and
      // nothing to delete. That matters because the completion signal is client-reported and
      // can go missing; an earlier design deleted real characters by treating its absence as
      // proof of abandonment.
      if ((account.characters ?? []).length >= MAX_CHARACTERS) {
        sendJson(res, 200, { ok: false, error: `You already have ${MAX_CHARACTERS} characters.` });
        return true;
      }
      const id = accounts.provisionalCharacterId();
      const now = new Date().toISOString();
      log('info', 'frontdoor.character_provisional', { account: account.name, id });
      sendJson(res, 200, { ok: true, character: { id, name: label, createdAt: now, lastPlayedAt: now, level: 1, needsChargen: true } });
      return true;
    }
    sendJson(res, 405, { error: 'method_not_allowed' });
    return true;
  };
}

// Re-entry tickets: the launcher's character-select screen needs to boot a world again after
// the original SSO ticket was spent (Exit -> character select -> pick another character). The
// locker Bearer token is the living proof of that SSO login, so minting a fresh single-use
// login ticket from it grants nothing the session did not already have.
export function ticketRoutes(
  accounts: AccountStore,
  lockerSessions: LockerSessionStore,
  tickets: LoginTicketStore,
): HttpRoute {
  return async (req, res, url) => {
    if (url.pathname !== '/auth/ticket') return false;
    res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return true; }
    const auth = req.headers.authorization ?? '';
    const accountKey = lockerSessions.resolve(auth.startsWith('Bearer ') ? auth.slice(7) : '');
    if (!accountKey) { sendJson(res, 401, { error: 'sign_in_first' }); return true; }
    const account = await accounts.get(accountKey);
    if (!account) { sendJson(res, 404, { error: 'no_account' }); return true; }
    const ticket = tickets.mint(accountKey, account.name);
    log('info', 'frontdoor.ticket_reissued', { account: account.name });
    sendJson(res, 200, { ticket });
    return true;
  };
}

export interface FrontDoor {
  // A single HttpRoute that handles /auth/* and /locker/*. Returns true when it claimed the
  // request; the directory handles everything else (/worlds, /healthz).
  route: HttpRoute;
  // Bearer token -> account key, for routes OUTSIDE this door that still must know who is
  // asking. POST /worlds is the one that matters: it used to take the account from the
  // request BODY, so anyone could spawn worlds under fabricated names and exhaust the
  // global cap while every per-owner limit read as satisfied.
  resolveAccount(authorizationHeader: string): string | undefined;
}

// All state lives in the shared dir; the same files the world processes read and write.
export async function buildFrontDoor(
  sharedDir: string,
  onCharacterDeleted?: (owner: { accountKey: string; username?: string }, charId: string) => void,
): Promise<FrontDoor> {
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
  // Derive the allow-list from the operator's own game data when they have not supplied one.
  // Without this the locker accepts nothing, every sign-in ends at "this server has no game
  // manifest configured yet", and the only clue is a log line reading vanilla:0 — an
  // operator-only step that nothing prompted for and nothing checked.
  await ensureVanillaManifest(sharedDir, gameDataDir(sharedDir));
  locker.configureAccepted(await loadVanillaManifest(sharedDir), [], {
    acceptByNameAndSize: config.locker.acceptByNameAndSize,
  });

  const providers = ['google', 'discord', 'microsoft'].filter(
    (p) => (config.auth as unknown as Record<string, { enabled?: boolean }>)[p]?.enabled,
  );
  log('info', 'frontdoor.ready', { requireSso: config.auth.requireSso, providers, locker: locker.enabled });

  // `also` is tried after the SSO routes: locker (/locker/*), profile (/auth/profile), then
  // characters (/auth/characters). Character stats live in the SHARED PlayerStore.
  const players = new PlayerStore(sharedDir);
  // The launcher enforces the world's content requirement BEFORE the player starts, so it has
  // to be told what that is. Same detection the sim peer's config is generated from, so the
  // checklist and the world can never disagree.
  const worldContent = detectGameData(gameDataDir(sharedDir));
  const locker2 = lockerRoutes({
    locker, sessions: lockerSessions,
    requiredContent: () => (worldContent.ok ? worldContent.contentFiles : []),
  });
  const profile = profileRoutes(accounts, lockerSessions);
  const chars = characterRoutes(accounts, lockerSessions, players, onCharacterDeleted);
  const reticket = ticketRoutes(accounts, lockerSessions, tickets);
  const also: HttpRoute = async (req, res, url) =>
    (await locker2(req, res, url)) || (await profile(req, res, url))
    || (await chars(req, res, url)) || (await reticket(req, res, url));
  const route = createAuthRoutes(
    { config, oidc, identities, tickets, sessions, lockerSessions, accounts, bans,
      limiter: new IpRateLimiter(config.limits.loginPerMinPerIp) },
    also,
  );
  return {
    route,
    resolveAccount: (auth: string) =>
      lockerSessions.resolve(auth.startsWith('Bearer ') ? auth.slice(7) : ''),
  };
}
