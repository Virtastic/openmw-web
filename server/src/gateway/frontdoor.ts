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

import type { IncomingMessage } from 'node:http';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { SocialStore } from '../core/socialstore';
import { detectGameData, gameDataDir } from '../core/gamedata';
import { orderedContent } from '../net/admin/api-mods';
import { loadConfig, assertMultiplayer } from '../config';
import { AccountStore, validEmail, validAccountName, MAX_CHARACTERS } from '../core/accounts';
import { PlayerStore } from '../persist/playerstore';
import { BanStore } from '../persist/banstore';
import { OidcService } from '../auth/oidc';
import { IdentityStore, LoginTicketStore, SessionIndex, LockerSessionStore, type AdminSessionStore } from '../auth/identities';
import type { AdminDeps } from '../net/admin/routes';
import { IpRateLimiter } from '../net/ratelimit';
import { createAuthRoutes } from '../auth/routes';
import { Locker, loadVanillaManifest } from '../data/locker';
import { ensureVanillaManifest } from '../data/vanilla-manifest';
import { lockerPublicBase, lockerStorageFrom, blobRoutes, FsStorage } from '../data/fsstorage';
import { eraseSaves } from '../data/save-routes';
import { lockerRoutes, esmOwnerGate } from '../data/locker-routes';
import { json as sendJson, readJsonBody, type HttpRoute } from '../net/http';
import { log } from '../log';


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
      try { body = (await readJsonBody(req, 8192)) as Record<string, unknown>; } catch { sendJson(res, 400, { error: 'bad_body' }); return true; }
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
  onCharacterDeleted?: (owner: { accountKey: string; username?: string }, charId: string) => void | Promise<void>,
  // Is this character in play right now (#284)? Deleting it from a second device used to stop
  // and remove the world the first device was standing in, which then reconnected forever.
  isPlayed?: (charId: string) => boolean,
  // Re-reads every world's status now. isPlayed answers from the last 5 s poll, so a player
  // who had just pressed Exit was still "in play" for up to a poll -- asked again before
  // refusing, so the refusal is about now, not about five seconds ago.
  refreshWorlds?: () => Promise<void>,
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
      if (isPlayed?.(id) && refreshWorlds) await refreshWorlds().catch(() => undefined);
      if (isPlayed?.(id)) { sendJson(res, 200, { ok: false, error: 'That character is being played right now. Sign out there first.' }); return true; }
      if (!accounts.deleteCharacter(account, id)) { sendJson(res, 200, { ok: false, error: 'No such character.' }); return true; }
      await accounts.flush();
      await players.erase(id);
      // AWAIT: the world owning this character has to be GONE before we can be sure the row
      // stays erased -- its shutdown drain ends in a players flush that would otherwise write
      // the character back as an orphan row nothing points at.
      await onCharacterDeleted?.(
        { accountKey: account.name.toLowerCase(), ...(account.username ? { username: account.username } : {}) }, id);
      // Erase again now the writer is gone. Idempotent, and the only way the deletion is
      // actually final: the first erase raced a live process holding the doc dirty.
      await players.erase(id);
      log('info', 'frontdoor.character_deleted', { account: account.name, character: id });
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (req.method === 'GET') {
      const chars = account.characters ?? [];
      // Level lives in the character's shared PlayerDoc, not on the slot. A brand-new slot
      // (never played, no chargen yet) has no doc — report level 1.
      const withLevel = await Promise.all(chars.map(async (c) => {
        // READ THROUGH, never cache. This store is the gateway's, and the WORLDS are what
        // actually write these docs — a level-up, a rename, a new logout position all land in
        // players.db from another process. get() answers from its own cache and never
        // re-reads, so the character-select screen served whatever was true the first time
        // the gateway saw the character and stayed that way until the gateway restarted:
        // stale level, stale name, and a boot position that could send the player to where
        // they were hours ago. Releasing after each read costs one query per tile.
        const doc = await players.get(c.id);
        await players.releaseCached(c.id);
        // The name the player typed in Morrowind's own character creation wins over the slot
        // label: it is what they actually called themselves, so the tile screen never has to
        // ask for an alias up front.
        return { id: c.id, name: doc?.appearance?.name || c.name,
          createdAt: c.createdAt, lastPlayedAt: c.lastPlayedAt,
          level: doc?.stats?.level ?? 1,
          // A slot needs chargen until creation FINISHED (the completed flag, reported by the
          // client at CharGenState == -1). v2 starts on a fresh data dir (CL16), so there are no
          // pre-flag characters to grandfather on doc.appearance (CL15). An abandoned creation therefore boots back INTO chargen (the world wipes its
          // partial doc at auth), never into a half-made character.
          needsChargen: c.completed !== true,
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
      try { body = (await readJsonBody(req, 8192)) as Record<string, unknown>; } catch { sendJson(res, 400, { error: 'bad_body' }); return true; }
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
      const id = accounts.provisionalCharacterId(accountKey);
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

interface FrontDoor {
  // A single HttpRoute that handles /auth/* and /locker/*. Returns true when it claimed the
  // request; the directory handles everything else (/worlds, /healthz).
  route: HttpRoute;
  // Bearer token -> account key, for routes OUTSIDE this door that still must know who is
  // asking. POST /worlds is the one that matters: it used to take the account from the
  // request BODY, so anyone could spawn worlds under fabricated names and exhaust the
  // global cap while every per-owner limit read as satisfied.
  resolveAccount(authorizationHeader: string): string | undefined;
  /** Mint a locker session for an account. BROWSER HARNESS ONLY -- main.ts wires it only
   *  when harness auth is already enabled, so production never has a caller. */
  mintSession(accountKey: string): string;
  /** May this request read /mwdata/* (a verified owner)? */
  mwdataGate(req: IncomingMessage): Promise<boolean>;
  /** Flush anything queued for outbound integrations before the process exits. */
  close(): Promise<void>;
  /** The shared account store, so the dashboard signs in against the same accounts. */
  accounts: AccountStore;
  /** Savegame storage for the dashboard's saves page; undefined when the locker is off. */
  saveStorage: AdminDeps['saveStorage'];
}

// All state lives in the shared dir; the same files the world processes read and write.
export async function buildFrontDoor(
  sharedDir: string,
  onCharacterDeleted?: (owner: { accountKey: string; username?: string }, charId: string) => void,
  // Only used to build blob URLs when storage falls back to this server's disk and the
  // operator set no [locker] publicBase — i.e. a single-machine dev run.
  gatewayPort = 8080,
  // The dashboard's session store, so an SSO round trip with return=admin can sign an
  // operator into the multiplayer server's dashboard the way it does into a game's.
  adminSessions?: AdminSessionStore,
  // The live world list (who is playing which character). Absent: a standalone front door.
  worldsNow?: () => { up: boolean; playerCount: number; id: string; players: { charId?: string }[] }[],
  // Poll every world's status right now (the gateway's WorldSupervisor.poll).
  refreshWorlds?: () => Promise<void>,
): Promise<FrontDoor> {
  const config = loadConfig(sharedDir, undefined, sharedDir);
  assertMultiplayer(config);
  const accounts = new AccountStore(sharedDir);
  const bans = new BanStore(sharedDir);
  const identities = new IdentityStore(sharedDir);
  const tickets = new LoginTicketStore(15 * 60_000, sharedDir); // file-backed: claimed by a world
  const sessions = new SessionIndex();
  const oidc = new OidcService(config.auth);
  // Minted AND resolved here, but PERSISTED: these are signed-in browser sessions, and a bare
  // in-memory store signed every player out on each deploy (the cloud/demo boot then dead-ends
  // at "No locker session"). The rows live beside the login tickets in the shared dir.
  const lockerSessions = new LockerSessionStore(24 * 60 * 60 * 1000, sharedDir, (k) => !!bans.isAccountBanned(k));
  // CL8: the Attio CRM hook is gone. Its outbox held queued player emails that nothing will
  // ever drain now, so delete it instead of keeping PII for no purpose.
  for (const f of ['attio.db', 'attio.db-wal', 'attio.db-shm']) rmSync(join(sharedDir, f), { force: true });

  // The operator's domain, exactly as a world derives it — not loopback. A multiplayer
  // deployment behind a domain was minting blob and savegame URLs no browser could reach.
  const storage = lockerStorageFrom(
    config.locker, sharedDir,
    lockerPublicBase(config.setup.domain, gatewayPort, config.locker.publicBase),
  );
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
  locker.configureAccepted(await loadVanillaManifest(sharedDir), { esmHashes: config.locker.esmHashes });

  const providers = ['google', 'discord'].filter(
    (p) => (config.auth as unknown as Record<string, { enabled?: boolean }>)[p]?.enabled,
  );
  log('info', 'frontdoor.ready', { requireSso: config.auth.requireSso, providers, locker: locker.enabled });

  // A HOSTED DEPLOYMENT OFFERING SSO SHOULD NOT ALSO ACCEPT PASSWORDS. Both defaults are
  // deliberately permissive because self-hosters are a real audience and some of them want
  // account+password — but on a deployment that has gone to the trouble of configuring OIDC
  // providers, leaving the password path open is an extra credential store to breach, an extra
  // brute-force surface, and a second identity for the same player. It is also silent: nothing
  // in the UI shows it, because the shipped launcher only ever offers SSO buttons.
  //
  // Warned, not refused: forcing it would break the self-hosters the defaults exist for.
  if (providers.length > 0 && config.auth.allowPasswordLogin) {
    log('warn', 'frontdoor.password_login_open', {
      providers,
      note: 'SSO providers are configured AND account+password login is still accepted. A '
        + 'hosted deployment should set [auth] requireSso = true, which forces allowPasswordLogin '
        + 'off. Ignore this if you deliberately offer both.',
    });
  }

  // `also` is tried after the SSO routes: locker (/locker/*), profile (/auth/profile), then
  // characters (/auth/characters). Character stats live in the SHARED PlayerStore.
  const players = new PlayerStore(sharedDir);
  // The launcher enforces the world's content requirement BEFORE the player starts, so it has
  // to be told what that is.
  //
  // This used to claim "the checklist and the world can never disagree" while passing no load
  // order at all, so a disabled expansion was still demanded of every player. It now reads the
  // one in the SHARED directory, which is the right answer for the single-world case (there
  // sharedDir and the world's dataDir are the same directory).
  //
  // IN GATEWAY MODE IT IS STILL AN APPROXIMATION, and deliberately so: every world is a child
  // process with its own dataDir and its own load order, so there is no single answer for a
  // front door that fronts all of them. A shared-dir list, when one exists, is the closest
  // thing to a house default; without one this behaves exactly as it did before. Per-world
  // checklists would mean asking each world, which is a different feature.
  const worldContent = detectGameData(gameDataDir(sharedDir),
    orderedContent(gameDataDir(sharedDir), sharedDir));
  const locker2 = lockerRoutes({
    locker, sessions: lockerSessions,
    requiredContent: () => (worldContent.ok ? worldContent.contentFiles : []),
    eraseSaves: (acct) => eraseSaves(sharedDir, acct, storage),
  });
  // Blob routes go BEFORE the locker's: these URLs carry their capability in the path and
  // have no Bearer header, which lockerRoutes would reject.
  const blobs = blobRoutes(storage instanceof FsStorage ? storage : undefined);
  const profile = profileRoutes(accounts, lockerSessions);
  // In play = the world's /status lists the character (charId is reported to the gateway).
  const chars = characterRoutes(accounts, lockerSessions, players, onCharacterDeleted, (charId) =>
    (worldsNow?.() ?? []).some((w) => w.up && w.players.some((p) => p.charId === charId)),
    refreshWorlds);
  const reticket = ticketRoutes(accounts, lockerSessions, tickets);
  const social = new SocialStore(sharedDir);
  const also: HttpRoute = async (req, res, url) =>
    (await blobs(req, res, url))
    || (await locker2(req, res, url)) || (await profile(req, res, url))
    || (await chars(req, res, url)) || (await reticket(req, res, url));
  const route = createAuthRoutes(
    { config, oidc, identities, tickets, sessions, lockerSessions, accounts, bans,
      ...(adminSessions ? { adminSessions } : {}),
      limiter: new IpRateLimiter(config.limits.loginPerMinPerIp) },
    also,
  );
  return {
    route,
    accounts,
    saveStorage: () => storage as unknown as ReturnType<NonNullable<AdminDeps['saveStorage']>>,
    close: async () => { social.close(); },
    resolveAccount: (auth: string) =>
      lockerSessions.resolve(auth.startsWith('Bearer ') ? auth.slice(7) : ''),
    // Mints a locker session directly, for the browser harness ONLY. Exposed here but wired
    // in main.ts only when the operator has already opted into harness auth, so in production
    // the route below simply does not exist rather than existing and checking a flag.
    mintSession: (accountKey: string) => lockerSessions.mint(accountKey),
    /** Who may read /mwdata/* (verified owners only). */
    mwdataGate: esmOwnerGate(locker, lockerSessions),
  };
}
