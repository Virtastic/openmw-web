// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The admin dashboard's HTTP surface.
//
// Replaces the original single-page moderation tool. The three endpoints that tool exposed
// (/admin/api/overview, /reports, /action) keep their exact request and response shapes,
// because operators have scripts pointed at them and a dashboard rewrite is no reason to
// break someone's cron job. Everything else is additive.
//
// Route table (role in brackets; "-" = unauthenticated):
//
//   GET  /admin                        [-]         the page
//   GET  /admin/static/*               [-]         vendored assets, app.js, app.css
//   GET  /admin/api/state              [-]         bootstrap: first-run? logged in? as whom?
//   POST /admin/api/login              [-]         password (+ TOTP) -> session token
//   POST /admin/api/logout             [viewer]
//   POST /admin/api/setup/owner        [-]         FIRST RUN ONLY: create the first owner
//   POST /admin/api/setup              [owner]     wizard answers -> config
//   POST /admin/api/setup/check-domain [owner]     is DNS pointed here, is HTTPS answering
//   GET  /admin/api/overview           [viewer]    (unchanged shape)
//   GET  /admin/api/reports            [moderator] (unchanged shape)
//   POST /admin/api/action             [moderator] (unchanged shape)
//   POST /admin/api/command            [moderator] the full ADMIN_COMMANDS console
//   GET  /admin/api/settings           [viewer]    every section, values + help
//   PUT  /admin/api/settings/:section  [owner]
//   GET  /admin/api/mods               [viewer]
//   PUT  /admin/api/mods               [owner]
//   GET  /admin/api/logs               [moderator] ring buffer + on-disk history
//   GET  /admin/api/metrics            [moderator] the existing registry, as JSON
//   GET  /admin/api/accounts           [moderator]
//   POST /admin/api/accounts/role      [owner]
//   POST /admin/api/accounts/delete    [owner]     the GDPR erasure path
//   GET  /admin/api/sessions           [owner]
//   POST /admin/api/sessions/revoke    [owner]
//   POST /admin/api/totp/enroll        [viewer]    (own account only)
//   POST /admin/api/totp/confirm       [viewer]
//   POST /admin/api/totp/disable       [viewer]
//   POST /admin/api/maintenance        [owner]
//   POST /admin/api/restart            [owner]
//   GET  /admin/api/export             [owner]     tar.gz of the data dir

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AccountStore, DashboardRole } from '../../core/accounts';
import { DASHBOARD_ROLES, accountNameProblem, looksLikeEmail, roleAtLeast } from '../../core/accounts';
import type { AdminSessionStore } from '../../auth/identities';
import type { IpRateLimiter } from '../ratelimit';
import { clientIp, isPrivateAddress, redirect } from '../http';
import { log } from '../../log';
import { json, readJson } from './util';
import { gate, passwordLogin, passwordProblem, resolveAuth, type AuthDeps } from './auth';
import { serveWebFile } from './static';
import type { SetupToken } from './setup-token';
import { generateSecret, totpUri, verifyTotp } from './totp';
import { settingsView, applySection, applyWizard, type WizardAnswers } from './api-settings';
import { checkDomain, normaliseDomain, VERIFY_PATH, VERIFY_NONCE } from './setup-check';
import { readDashboardTree } from './settings-store';
import { writeCaddyfile, launcherEnabled } from './caddy-config';
import { modsView, saveMods, uploadContent, gameDataWritable } from './api-mods';
import type { LogEntry } from '../../log';

export interface AdminDeps {
  dataDir: string;
  sharedDir?: string;
  /** Re-read each call: the settings page must show what a restart would actually load. */
  config(): unknown;
  accounts: AccountStore;
  sessions: AdminSessionStore;
  loginLimiter: IpRateLimiter;
  apiLimiter: IpRateLimiter;
  sharedToken: string;
  /** Gates creation of the first owner. See setup-token.ts for why this is not inferrable
   *  from account state. */
  setupToken: SetupToken;

  // --- the original moderation surface, unchanged ---
  overview(): unknown | Promise<unknown>;
  reports(limit: number): Promise<unknown>;
  action(kind: string, target: string, detail: string): Promise<{ ok: boolean; message: string }>;

  // --- new capability, supplied by server.ts so this module stays free of game types ---
  /** Run one ADMIN_COMMANDS entry as `actor`. Returns the same text the chat path returns. */
  runCommand(actor: { accountKey: string; name: string; rank: number }, line: string):
    Promise<{ ok: boolean; message: string }>;
  /** Which commands exist, and what each needs, drives the console UI. */
  commandCatalog(): { name: string; usage: string; help: string; minRank: number; inGameOnly?: boolean }[];
  recentLogs(limit: number, filter: string): LogEntry[];
  metricsSnapshot(): unknown;
  gameDataDir: string;
  /** Shown in the dashboard footer. */
  version: string;
  maintenance: { get(): { on: boolean; message: string }; set(on: boolean, message: string): void };
  restart(reason: string): void;
  exportData(res: ServerResponse): Promise<void>;
  deleteAccount(key: string): Promise<{ ok: boolean; message: string }>;

  /** Is outgoing mail set up? Gates whether password recovery is offered at all. */
  mailConfigured(): boolean;
  /** Fire-and-forget: never reveals whether the account or its address exists. */
  sendPasswordReset(name: string): Promise<void>;
  applyPasswordReset(token: string, password: string): Promise<{ ok: boolean; message: string }>;
}

const ROLE_SET = new Set<string>(DASHBOARD_ROLES);


/** The single sign-on providers the wizard offers. */
const SSO_PROVIDERS = ['discord', 'google', 'microsoft'];


/**
 * What each legacy /action kind requires, mirroring the ranks in core/admin.ts: kick is
 * rank 1 there, ban/unban/ipban are rank 2. mute and broadcast have no in-game command and
 * are moderator-shaped by nature. resetCell wipes a cell's contents and is owner-only -
 * it has no command equivalent, so nothing else was gating it at all.
 */
const ACTION_ROLE: Record<string, DashboardRole> = {
  kick: 'moderator',
  mute: 'moderator',
  unmute: 'moderator',
  broadcast: 'moderator',
  ban: 'moderator',
  unban: 'moderator',
  // No in-game equivalent, so nothing was gating this anywhere. It wipes a cell's contents -
  // containers, dropped items, doors, for everyone. Owner.
  resetCell: 'owner',
};

export function adminRoutes(deps: AdminDeps) {
  // PER SERVER, not per module. These were module-level and it was wrong even though a real
  // deployment could never see it: one process runs one server, so the shared state looked
  // harmless. The test suite builds dozens in a single process and caught it immediately -
  // one server completing setup made every subsequently created server report itself as
  // already claimed. State that belongs to an instance goes on the instance.

  /** Serialises first-owner creation. Without it two requests arriving together both pass
   *  the "no owner yet" check and both become owner. */
  let setupInFlight: Promise<{ ok: true } | { error: string }> | null = null;

  /** Cached answer to "has anyone claimed this server yet". Only /setup/owner changes it,
   *  and it invalidates the cache when it does. */
  let firstRunCache: boolean | null = null;

  /** Set when the wizard applies with completed:true. Config is only re-read at boot, so
   *  without this the redirect on "/" would keep sending finished operators back to setup
   *  for the seconds between saving and the restart landing. */
  let setupCompletedNow = false;
  const setupIsComplete = (): boolean => setupCompletedNow
    || pending('setup').completed === true;

  /**
   * A config section as it will be AFTER the next restart: what the dashboard has written,
   * over what is currently loaded.
   *
   * The wizard pre-fills from this, and the loaded config alone is the wrong source for
   * that. Configuration is only re-read at boot, so a value saved a moment ago still reads
   * as its old self — and since the wizard sends every answer on every save, re-entering it
   * would write that stale (usually empty) value straight back over the real one. That is
   * how a second run through Setup blanked a working domain and took the certificate with
   * it. Reading the override file means the wizard sees its own last answer.
   */
  const pending = (section: string): Record<string, unknown> => {
    const loaded = (deps.config() as Record<string, unknown>)[section];
    const base = (loaded !== null && typeof loaded === 'object' && !Array.isArray(loaded))
      ? loaded as Record<string, unknown> : {};
    let saved: Record<string, unknown> = {};
    try {
      const tree = readDashboardTree(deps.dataDir)[section];
      if (tree !== null && typeof tree === 'object' && !Array.isArray(tree)) {
        saved = tree as Record<string, unknown>;
      }
    } catch { /* unreadable override file: the loaded values are still a fair answer */ }
    return { ...base, ...saved };
  };

  const lockerStr = (key: string): string => {
    const v = pending('locker')[key];
    return typeof v === 'string' ? v : '';
  };

  const providerTable = (p: string): Record<string, unknown> => {
    const t = pending('auth')[p];
    return (t !== null && typeof t === 'object' && !Array.isArray(t))
      ? t as Record<string, unknown> : {};
  };
  const ssoEnabled = (p: string): boolean => providerTable(p).enabled === true;
  const ssoHasKeys = (p: string): boolean => {
    const t = providerTable(p);
    return typeof t.clientId === 'string' && t.clientId !== ''
      && typeof t.clientSecret === 'string' && t.clientSecret !== '';
  };

  const auth: AuthDeps = {
    sharedToken: deps.sharedToken,
    accounts: deps.accounts,
    sessions: deps.sessions,
    loginLimiter: deps.loginLimiter,
    apiLimiter: deps.apiLimiter,
  };

  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const path = url.pathname;
    // "/" and "/play" belong to this router too: the sign-in landing page lives with the
    // dashboard's static assets, and this is the only place that serves them.
    if (path !== '/admin' && !path.startsWith('/admin/') && path !== '/' && path !== '/play'
        && path !== VERIFY_PATH) return false;

    // HEAD is a GET without a body, and Node drops the body for us. Matching only on the
    // literal method meant HEAD /admin answered 404, which uptime checks and link checkers
    // read as "the dashboard is gone".
    const method = req.method === 'HEAD' ? 'GET' : (req.method ?? 'GET');

    // --- the page and its assets ---------------------------------------------------------
    // Served unauthenticated on purpose: the HTML and JS can do nothing without a token, and
    // a login form that requires a login to fetch is not a login form. Unlike the old
    // dashboard this is NOT gated on a token being configured, accounts are the way in now,
    // and hiding the page would hide first-run setup, which is the whole point.
    // The reachability probe's target. Unauthenticated on purpose and safe by construction:
    // it returns one random value this process invented, which proves only that you reached
    // THIS server. That is the entire question the hosting step needs answered, and no other
    // signal can answer it: DNS resolving proves the name points somewhere, and something
    // answering on 443 proves a machine is there, but neither proves it is this one.
    if (method === 'GET' && path === VERIFY_PATH) {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end(VERIFY_NONCE);
      return true;
    }

    // The front door. "/" used to 404, which is what a player following the join link saw
    // first. This is a sign-in landing page whose options mirror what the operator enabled;
    // when the game client is staged in front of us its files win, but the ROOT path is
    // routed here deliberately (see Caddyfile), the login screen is the default entry now,
    // not launcher.html.
    if (method === 'GET' && (path === '/' || path === '/play')) {
      // Before setup is finished there is nothing here to sign in to: no sign-in method has
      // been chosen, the world cannot run, and the landing page would offer a player a door
      // into a server that is not built yet. Send everyone to the one thing that matters
      // until it is, which is also what the operator opening the bare address expects.
      if (!setupIsComplete() || !deps.accounts.hasDashboardOwner()) {
        redirect(res, '/admin');
        return true;
      }
      if (serveWebFile(res, 'play.html')) return true;
      json(res, 500, { error: 'landing page missing' });
      return true;
    }
    if (method === 'GET' && (path === '/admin' || path === '/admin/')) {
      if (serveWebFile(res, 'index.html')) return true;
      json(res, 500, { error: 'dashboard assets missing' });
      return true;
    }
    if (method === 'GET' && path.startsWith('/admin/static/')) {
      if (!serveWebFile(res, decodeURIComponent(path.slice('/admin/static/'.length)))) {
        json(res, 404, { error: 'not found' });
      }
      return true;
    }

    // --- bootstrap ------------------------------------------------------------------------
    // Tells the page which of three worlds it is in: nobody has set this server up yet, or
    // you are logged out, or here is who you are. Unauthenticated by necessity.
    if (method === 'GET' && path === '/admin/api/state') {
      // Rate-limited despite being unauthenticated, for two reasons. It scans the whole
      // account table to answer "first run?", so it was a cheap amplification target. And it
      // reports whether a presented credential worked, which made it an unlimited, unlogged
      // oracle for guessing an operator-chosen [admin].dashboardToken, session tokens are
      // 32 random bytes and not worth guessing, but that one is typed by a human.
      if (!deps.apiLimiter.allow(clientIp(req))) {
        json(res, 429, { error: 'rate limited' });
        return true;
      }
      // The answer only ever flips once, and this process is the only thing that can flip
      // it, so cache it rather than re-scanning on every poll.
      if (firstRunCache === null) firstRunCache = !deps.accounts.hasDashboardOwner();
      const firstRun = firstRunCache && deps.setupToken.armed;
      // Whether this particular visitor will be asked for the setup key, so the page only
      // shows that field to someone who actually needs it. See the setup route for why.
      const needsSetupKey = firstRun && !isPrivateAddress(clientIp(req));
      const ctx = await resolveAuth(req, auth);
      json(res, 200, {
        firstRun,
        needsSetupKey,
        authed: !!ctx,
        role: ctx?.role ?? null,
        name: ctx?.accountName ?? null,
        maintenance: deps.maintenance.get(),
        // Server-side truth for the "add two-factor" nudge. It used to be a localStorage
        // flag, so the reminder reappeared on every other browser and never cleared on the
        // one that mattered.
        twoFactor: ctx && !ctx.viaSharedToken
          ? !!(await deps.accounts.get(ctx.accountKey))?.totpSecret
          : false,
        // Deliberately NOT reporting this machine's network interfaces. Inside a container
        // they are the Docker bridge (172.18.0.2 and friends), which is reachable from
        // nothing the operator cares about, and handing that over as "your address" is a
        // wrong answer given confidently. The address that IS known to work is the one the
        // browser used to get here, and the page reads that itself.
        // For the top bar and footer, which had markup slots and nothing filling them.
        serverName: (deps.config() as { server?: { name?: string } }).server?.name ?? '',
        version: deps.version,
        // Server-side, so the getting-started nudge answers the same on every machine
        // instead of being a per-browser localStorage flag.
        // Same in-process answer the "/" redirect uses, so the page unlocks the moment the
        // wizard saves rather than only once the restart has landed. A restart that fails
        // must not leave the operator sealed inside a wizard they already finished.
        setupCompleted: setupIsComplete(),
        // The wizard's stored answers, whole. The page branches on these, a single-player
        // deployment hides the multiplayer pages, and re-entering Setup pre-fills from them
        // instead of presenting every question blank and saving blanks back over the answers.
        setup: {
          ...pending('setup'),
          // Storage details the wizard must pre-fill on a re-run. The KEYS are deliberately
          // absent: they are secrets, and the page only needs to know a pair is already
          // stored so it stops demanding two values the operator cannot see.
          s3Endpoint: lockerStr('endpoint'),
          s3Bucket: lockerStr('bucket'),
          s3Region: lockerStr('region') || 'auto',
          storageConfigured: lockerStr('accessKeyId') !== '' && lockerStr('secretAccessKey') !== '',
          // Providers switched ON but with no credentials. They are enabled in config and
          // never offered on the sign-in page, because there is nothing to sign in with, so
          // the operator picked a button they will then be unable to find. Named here so the
          // wizard can pre-fill, and the getting-started checklist can nag until it is done.
          ssoConfigured: SSO_PROVIDERS.filter((p) => ssoHasKeys(p)),
          ssoNeedsKeys: SSO_PROVIDERS.filter((p) => ssoEnabled(p) && !ssoHasKeys(p)),
        },
        // Surfaced even to a logged-out page so a boot-time revert is visible immediately,
        // not only to whoever eventually logs in.
        configFallback: (deps.config() as { dashboardFallback?: string }).dashboardFallback ?? null,
      });
      return true;
    }

    if (method === 'POST' && path === '/admin/api/login') {
      const body = await readJson<{ name?: string; password?: string; totp?: string }>(req, res);
      if (body === undefined) return true;
      const result = await passwordLogin(
        auth, clientIp(req),
        String(body.name ?? ''), String(body.password ?? ''), String(body.totp ?? ''),
      );
      if (!result.ok) {
        json(res, result.status, { error: result.error, totpRequired: result.totpRequired ?? false });
        return true;
      }
      json(res, 200, { token: result.token, role: result.role, name: result.name });
      return true;
    }

    // --- password recovery ------------------------------------------------------------------
    // Offered only when mail is actually configured. A "forgot password" link that silently
    // does nothing is worse than no link: it makes an operator think help is coming.
    if (method === 'POST' && path === '/admin/api/forgot-password') {
      const body = await readJson<{ name?: string }>(req, res);
      if (body === undefined) return true;
      if (!deps.mailConfigured()) {
        json(res, 501, { error: 'no mail is configured on this server' });
        return true;
      }
      if (!deps.loginLimiter.allow(clientIp(req))) {
        json(res, 429, { error: 'too many attempts, wait a minute' });
        return true;
      }
      // Always the same answer, whether or not that account exists or has an address on
      // file. Anything else turns this into a way to enumerate accounts and email addresses.
      void deps.sendPasswordReset(String(body.name ?? ''));
      json(res, 200, { ok: true, message: 'if that account can receive mail, a reset link is on its way' });
      return true;
    }
    if (method === 'POST' && path === '/admin/api/reset-password') {
      const body = await readJson<{ token?: string; password?: string }>(req, res);
      if (body === undefined) return true;
      if (!deps.loginLimiter.allow(clientIp(req))) {
        json(res, 429, { error: 'too many attempts, wait a minute' });
        return true;
      }
      const result = await deps.applyPasswordReset(String(body.token ?? ''), String(body.password ?? ''));
      json(res, result.ok ? 200 : 400, result);
      return true;
    }

    // --- FIRST RUN: create the first owner ------------------------------------------------
    // Requires the setup key the server printed at boot (see setup-token.ts for why account
    // state alone cannot gate this). Serialised through a single-flight promise: two requests
    // arriving together would otherwise both pass the "no owner yet" check and both become
    // owner.
    if (method === 'POST' && path === '/admin/api/setup/owner') {
      if (!deps.loginLimiter.allow(clientIp(req))) {
        json(res, 429, { error: 'too many attempts, wait a minute' });
        return true;
      }
      const body = await readJson<{ name?: string; password?: string; setupKey?: string }>(req, res);
      if (body === undefined) return true;

      if (!deps.setupToken.armed || deps.accounts.hasDashboardOwner()) {
        json(res, 409, { error: 'setup has already been completed on this server' });
        return true;
      }

      // THE KEY IS FOR STRANGERS, NOT FOR YOU.
      //
      // Requiring it unconditionally was wrong. The whole promise is "start it, open /admin,
      // the browser walks you through the rest", and demanding a value that only exists in
      // a log line or a file sends you straight back to a terminal, which is the one thing
      // this was built to avoid.
      //
      // The risk it guards against is specific: a server reachable from the internet being
      // claimed by whoever finds it first. That risk does not exist for a request coming
      // from this machine or this network, and the person who just ran `docker compose up`
      // is, essentially always, exactly there. So: local or LAN, no key. From the internet,
      // key required, and that operator has a shell on the box by definition, because they
      // put it on the internet.
      //
      // clientIp(), not the socket peer: behind the bundled Caddy every peer is the proxy's
      // own private address, so testing the peer would wave through the entire internet.
      const from = clientIp(req);
      const local = isPrivateAddress(from);
      if (!local && !deps.setupToken.verify(String(body.setupKey ?? ''))) {
        log('warn', 'admin.setup_bad_key', { ip: from });
        json(res, 401, {
          error: 'This server is being set up from outside its own network, so it needs the '
            + 'setup key. It was printed in the log when the server started, and is saved as '
            + '"setup-token" in the data folder.',
          needsKey: true,
        });
        return true;
      }

      const name = String(body.name ?? '').trim();
      const password = String(body.password ?? '');
      // A NEW owner signs in with an email: it is the login identifier (players see
      // `username`, never this), and holding it means password recovery works the day it is
      // needed rather than requiring shell access to the box.
      //
      // An EXISTING account is exempt, whatever it is called. Someone who has been playing
      // here as "Bob" and now sets up the dashboard must still be able to adopt their own
      // account, and that path already proves the password below, so it is not the weaker
      // check. Demanding an email here would lock the legitimate case out to enforce a
      // convention that only governs names this server hands out.
      const alreadyRegistered = (await deps.accounts.get(name)) !== undefined;
      if (!alreadyRegistered && !looksLikeEmail(name)) {
        const why = accountNameProblem(name);
        json(res, 400, { error: why === null
          ? 'use an email address to sign in, for example you@example.com'
          : `that email address ${why}` });
        return true;
      }
      const result = await (setupInFlight = (setupInFlight ?? Promise.resolve()).then(async () => {
        if (deps.accounts.hasDashboardOwner()) return { error: 'setup has already been completed on this server' };
        // An account may already exist, someone played on this server before anyone set the
        // dashboard up. Promoting it is legitimate, but ONLY on proof of its password. The
        // setup key proves access to the machine; it does not entitle the holder to take over
        // a specific player's identity, and that account may belong to somebody else.
        const existing = await deps.accounts.get(name);
        if (existing) {
          // NO strength check on this path. The password is not being set, it is being
          // proved, running new-password rules over one that already exists means an
          // account with a weak but genuine password can never be adopted by its owner,
          // which is a lockout dressed up as a security control.
          if (!await deps.accounts.verifyLogin(name, password)) {
            return { error: `an account named "${name}" already exists. Enter its existing `
              + 'password to make it the administrator, or choose a different name.' };
          }
        } else {
          const weak = passwordProblem(password, name);
          if (weak) return { error: `password ${weak}` };
          const created = await deps.accounts.register(name, password);
          if (typeof created === 'string') {
            return { error: created === 'exists' ? 'name taken' : 'invalid name' };
          }
        }
        // The sign-in address is also contact data, so "forgot my password" can work as
        // soon as mail is configured. Without this the only recovery is --admin-reset,
        // which needs a shell on the box: the exact dead end this dashboard exists to avoid.
        // Only when the identifier IS an address: an adopted plain-named account would
        // otherwise get "Bob" recorded as its email, and reset mail sent into the void.
        const account = await deps.accounts.get(name);
        if (account && looksLikeEmail(name) && !account.email) deps.accounts.setEmail(account, name);
        await deps.accounts.setDashboardRole(name, 'owner');
        deps.accounts.setRank(name, 3); // in-game parity: the first owner is an owner in-world
        // Also record them in [admin].owners so the every-boot promotion keeps them rank 3
        // even with a cold account cache. Not fatal if it fails, the role is what gates the
        // dashboard, so a read-only data dir still yields a usable login.
        applyWizard(deps.dataDir, { owners: [name] }, deps.sharedDir);
        await deps.accounts.flush();
        deps.setupToken.disarm();
        firstRunCache = false;
        return { ok: true as const };
      }));

      if ('error' in result) { json(res, 400, { error: result.error }); return true; }
      const key = name.toLowerCase();
      const token = deps.sessions.mint(key, clientIp(req));
      log('warn', 'admin.setup_owner', { account: key, ip: clientIp(req) });
      json(res, 200, { token, role: 'owner', name });
      return true;
    }

    // ======================================================================================
    // Everything below requires a credential. One gate, one place, no exceptions.
    // ======================================================================================

    if (method === 'POST' && path === '/admin/api/logout') {
      const ctx = await gate(req, res, auth, 'viewer');
      if (!ctx) return true;
      const presented = (req.headers.authorization ?? '').slice(7);
      deps.sessions.revoke(presented);
      json(res, 200, { ok: true });
      return true;
    }

    // --- the original three, byte-compatible ----------------------------------------------
    if (method === 'GET' && path === '/admin/api/overview') {
      if (!await gate(req, res, auth, 'viewer')) return true;
      json(res, 200, await deps.overview());
      return true;
    }
    if (method === 'GET' && path === '/admin/api/reports') {
      if (!await gate(req, res, auth, 'moderator')) return true;
      json(res, 200, await deps.reports(Number(url.searchParams.get('limit') ?? 20)));
      return true;
    }
    if (method === 'POST' && path === '/admin/api/action') {
      const ctx = await gate(req, res, auth, 'moderator');
      if (!ctx) return true;
      const body = await readJson<{ kind?: string; target?: string; detail?: string }>(req, res, 8192);
      if (body === undefined) return true;
      const kind = String(body.kind ?? '');
      // PER-ACTION ROLE, because "one privilege model" has to mean it. This endpoint predates
      // the command console and calls into the server directly, so gating the whole route at
      // moderator quietly handed out capabilities the in-game table puts at rank 2: the same
      // moderator refused /ban in the console succeeded with {kind:"ban"} here. resetCell is
      // worse, it destroys world state and has no in-game equivalent, so it had no rank gate
      // anywhere. Mapped to the ranks core/admin.ts already defines.
      const needed = ACTION_ROLE[kind];
      if (needed && !roleAtLeast(ctx.role, needed)) {
        log('warn', 'admin.denied', { account: ctx.accountKey, action: kind, need: needed, have: ctx.role });
        json(res, 403, { error: `"${kind}" needs the ${needed} role`, need: needed });
        return true;
      }
      const result = await deps.action(
        kind, String(body.target ?? ''), String(body.detail ?? ''),
      );
      log('info', 'admin.dashboard_action',
        { kind: body.kind, target: body.target, ok: result.ok, by: ctx.accountKey });
      json(res, result.ok ? 200 : 400, result);
      return true;
    }

    // --- the full command console ----------------------------------------------------------
    if (method === 'GET' && path === '/admin/api/commands') {
      if (!await gate(req, res, auth, 'moderator')) return true;
      json(res, 200, { commands: deps.commandCatalog() });
      return true;
    }
    if (method === 'POST' && path === '/admin/api/command') {
      const ctx = await gate(req, res, auth, 'moderator');
      if (!ctx) return true;
      const body = await readJson<{ line?: string }>(req, res, 16 * 1024);
      if (body === undefined) return true;
      const line = String(body.line ?? '').trim();
      if (line === '') { json(res, 400, { ok: false, message: 'empty command' }); return true; }
      // The dashboard role maps onto the in-game rank the command table already enforces, so
      // there is exactly one privilege model rather than two that must be kept in agreement.
      //
      // moderator -> 2, not 1. The UI promises a moderator can "kick, ban, mute, broadcast,
      // read chat history and logs", and ban/unban/ipban are rank 2 in core/admin.ts. Mapping
      // to 1 meant the console refused a ban that the older /action endpoint allowed, the
      // same person, the same server, two different answers. Rank 2 keeps the dangerous
      // things (setrank, console) at rank 3, which is owner-only either way.
      const rank = ctx.role === 'owner' ? 3 : ctx.role === 'moderator' ? 2 : 0;
      const result = await deps.runCommand(
        { accountKey: ctx.accountKey, name: ctx.accountName, rank }, line,
      );
      json(res, 200, result);
      return true;
    }

    // --- settings --------------------------------------------------------------------------
    if (method === 'GET' && path === '/admin/api/settings') {
      if (!await gate(req, res, auth, 'viewer')) return true;
      json(res, 200, settingsView(deps.dataDir, deps.config()));
      return true;
    }
    if (method === 'PUT' && path.startsWith('/admin/api/settings/')) {
      const ctx = await gate(req, res, auth, 'owner');
      if (!ctx) return true;
      const section = decodeURIComponent(path.slice('/admin/api/settings/'.length));
      const body = await readJson<Record<string, unknown>>(req, res);
      if (body === undefined) return true;
      const result = applySection(deps.dataDir, section, body, deps.sharedDir);
      if (!result.ok) { json(res, 400, { error: result.error }); return true; }
      // A DOMAIN THAT DOES NOT REACH THE PROXY IS NOT A DOMAIN. The wizard's own save has
      // always rewritten the Caddyfile; this path never did, because [setup] was not editable
      // here. Now that it is, saving a domain has to do the same thing or it would be a text
      // box that silently changes nothing — the exact failure that got publicBase removed.
      // Caddy watches the file, so the certificate follows within seconds, no restart.
      if (section === 'setup' && Object.hasOwn(body, 'domain' as string)
          || section === 'setup' && Object.hasOwn(body, 'hosting' as string)) {
        const pend = pending('setup') as { domain?: unknown; hosting?: unknown };
        const domain = pend.hosting === 'internal' ? '' : normaliseDomain(String(pend.domain ?? ''));
        writeCaddyfile(deps.dataDir, { domain, launcher: launcherEnabled() });
        log('info', 'admin.proxy_reconfigured', { by: ctx.accountKey, domain: domain || '(none)' });
      }
      log('info', 'admin.config_changed', { section, by: ctx.accountKey, keys: Object.keys(body) });
      json(res, 200, { ok: true, restartRequired: true });
      return true;
    }

    // Live verification for the wizard's hosting step: does the domain resolve, and does an
    // HTTPS request to it actually answer? Run FROM THE SERVER, so it tests the path players
    // will use rather than the operator's own machine. The one blind spot is hairpin NAT -
    // some home routers cannot reach their own public address from inside, so a failure is
    // reported as "could not confirm", never "definitely broken".
    if (method === 'POST' && path === '/admin/api/setup/check-domain') {
      const ctx = await gate(req, res, auth, 'owner');
      if (!ctx) return true;
      const body = await readJson<{ domain?: string }>(req, res);
      if (body === undefined) return true;
      const domain = normaliseDomain(String(body.domain ?? ''));
      // The last label must contain a letter: that shape-checks a NAME and rejects a bare
      // IP address, so this endpoint cannot be pointed at internal addresses directly. The
      // caller is an owner either way; this is belt and braces, not the trust boundary.
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)
          || !/[a-z]/.test(domain.split('.').pop() ?? '')) {
        json(res, 400, { error: 'that does not look like a domain name (e.g. mp.example.com)' });
        return true;
      }
      json(res, 200, await checkDomain(domain));
      return true;
    }

    // Update check, on demand rather than on a timer: it calls out to GitHub, and a LAN
    // server with no internet must not accumulate failed requests in its logs for a
    // feature nobody asked it to run. The answer names the fix (setup script, --update)
    // because a container cannot `docker pull` itself.
    if (method === 'GET' && path === '/admin/api/updates') {
      if (!await gate(req, res, auth, 'owner')) return true;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 6000);
        const r = await fetch('https://api.github.com/repos/Virtastic/openmw-web/releases/latest', {
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'openmw-web-dashboard' },
          signal: ctl.signal,
        });
        clearTimeout(timer);
        if (!r.ok) { json(res, 200, { ok: false, current: deps.version, reason: `GitHub answered ${r.status}` }); return true; }
        const rel = await r.json() as { tag_name?: string; html_url?: string };
        const latest = String(rel.tag_name ?? '').replace(/^v/, '');
        json(res, 200, {
          ok: true,
          current: deps.version,
          latest,
          behind: latest !== '' && latest !== deps.version,
          url: rel.html_url ?? '',
        });
      } catch {
        json(res, 200, { ok: false, current: deps.version, reason: 'could not reach GitHub (offline is fine; check by hand when convenient)' });
      }
      return true;
    }

    // --- onboarding wizard -------------------------------------------------------------------
    if (method === 'POST' && path === '/admin/api/setup') {
      const ctx = await gate(req, res, auth, 'owner');
      if (!ctx) return true;
      const body = await readJson<WizardAnswers>(req, res);
      if (body === undefined) return true;
      const result = applyWizard(deps.dataDir, body, deps.sharedDir);
      if (!result.ok) { json(res, 400, { error: result.error }); return true; }
      // Apply the hosting answer to the proxy immediately. Caddy watches this file, so the
      // certificate is requested within seconds — the wizard sets up HTTPS itself instead of
      // printing a line for the operator to paste into a file it cannot reach.
      // Normalised here too: the API is reachable without the page, and a scheme or a
      // trailing slash reaching the proxy config is what made the join link nonsense.
      const domain = body.hosting === 'internal' ? '' : normaliseDomain(String(body.domain ?? ''));
      writeCaddyfile(deps.dataDir, { domain, launcher: launcherEnabled() });
      if (body.completed === true) setupCompletedNow = true;
      log('info', 'admin.setup_applied', { by: ctx.accountKey, mode: body.deploymentMode });
      json(res, 200, { ok: true, restartRequired: true });
      return true;
    }

    // --- mods ---------------------------------------------------------------------------------
    if (method === 'GET' && path === '/admin/api/mods') {
      if (!await gate(req, res, auth, 'viewer')) return true;
      json(res, 200, {
        ...(modsView(deps.gameDataDir, deps.dataDir, url.searchParams.get('profile') ?? undefined) as object),
        writable: gameDataWritable(deps.gameDataDir),
      });
      return true;
    }
    // Upload streams straight to disk, so it must NOT go through readJson's buffering, a
    // 400 MB archive is not a JSON body. Owner only: this writes files the engine will load.
    if (method === 'POST' && path === '/admin/api/mods/upload') {
      // Budget-exempt: one request per file, and a Data Files folder is thousands of them.
      // See the parameter's own comment in auth.ts for why that is safe here.
      const ctx = await gate(req, res, auth, 'owner', true);
      if (!ctx) return true;
      const result = await uploadContent(
        req, res, deps.gameDataDir, url.searchParams.get('name') ?? '',
      );
      if (!result.ok) { json(res, result.status, { error: result.error }); return true; }
      log('info', 'admin.mods_uploaded', { by: ctx.accountKey, file: result.file });
      json(res, 200, { ok: true, file: result.file, bytes: result.bytes, restartRequired: true });
      return true;
    }
    if (method === 'PUT' && path === '/admin/api/mods') {
      const ctx = await gate(req, res, auth, 'owner');
      if (!ctx) return true;
      const body = await readJson<{ entries?: { file?: string; enabled?: boolean }[] }>(req, res);
      if (body === undefined) return true;
      const result = saveMods(deps.gameDataDir, deps.dataDir, body.entries ?? []);
      if (!result.ok) { json(res, 400, { error: result.error }); return true; }
      log('info', 'admin.mods_changed', { by: ctx.accountKey, count: (body.entries ?? []).length });
      json(res, 200, { ok: true, restartRequired: true });
      return true;
    }

    // --- logs and metrics ----------------------------------------------------------------------
    if (method === 'GET' && path === '/admin/api/logs') {
      if (!await gate(req, res, auth, 'moderator')) return true;
      const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') ?? 200)), 2000);
      json(res, 200, { entries: deps.recentLogs(limit, url.searchParams.get('filter') ?? '') });
      return true;
    }
    if (method === 'GET' && path === '/admin/api/metrics') {
      if (!await gate(req, res, auth, 'moderator')) return true;
      json(res, 200, deps.metricsSnapshot());
      return true;
    }

    // --- accounts -------------------------------------------------------------------------------
    if (method === 'GET' && path === '/admin/api/accounts') {
      if (!await gate(req, res, auth, 'moderator')) return true;
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const all = deps.accounts.listAll()
        .filter((a) => q === '' || a.name.toLowerCase().includes(q) || (a.username ?? '').toLowerCase().includes(q))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 500)
        .map((a) => ({
          name: a.name,
          username: a.username ?? null,
          rank: a.rank,
          dashboardRole: a.dashboardRole ?? null,
          banned: !!a.banned,
          twoFactor: !!a.totpSecret,
          createdAt: a.createdAt,
          lastSeenAt: a.lastSeenAt,
          // Email is contact data. A moderator listing does not need it and this response
          // travels to a browser, so it stays out of the payload entirely.
        }));
      json(res, 200, { accounts: all });
      return true;
    }
    // Create an account with dashboard access in one step, the wizard's "anyone else
    // helping you run this?" question, and the Accounts page's add button. Without this,
    // giving a co-admin access meant telling them to register in the game first, which is
    // a terminal-shaped answer to a browser-shaped question.
    if (method === 'POST' && path === '/admin/api/accounts/create') {
      const ctx = await gate(req, res, auth, 'owner');
      if (!ctx) return true;
      const body = await readJson<{ name?: string; password?: string; role?: string }>(req, res);
      if (body === undefined) return true;
      const name = String(body.name ?? '').trim();
      const password = String(body.password ?? '');
      const role = String(body.role ?? 'moderator');
      if (!ROLE_SET.has(role)) { json(res, 400, { error: 'unknown role' }); return true; }
      const why = accountNameProblem(name);
      if (why !== null) { json(res, 400, { error: `that name ${why}` }); return true; }
      const weak = passwordProblem(password, name);
      if (weak) { json(res, 400, { error: `password ${weak}` }); return true; }
      const created = await deps.accounts.register(name, password);
      if (typeof created === 'string') {
        json(res, 400, { error: created === 'exists'
          ? 'that name is taken, to grant an existing account access, use its row in the list instead'
          : 'invalid name' });
        return true;
      }
      await deps.accounts.setDashboardRole(name, role as DashboardRole);
      await deps.accounts.flush();
      log('warn', 'admin.account_created', { account: name.toLowerCase(), role, by: ctx.accountKey });
      json(res, 200, { ok: true, name, role });
      return true;
    }
    if (method === 'POST' && path === '/admin/api/accounts/role') {
      const ctx = await gate(req, res, auth, 'owner');
      if (!ctx) return true;
      const body = await readJson<{ name?: string; role?: string | null }>(req, res);
      if (body === undefined) return true;
      const name = String(body.name ?? '');
      const role = body.role == null || body.role === '' ? undefined : String(body.role);
      if (role !== undefined && !ROLE_SET.has(role)) {
        json(res, 400, { error: 'unknown role' }); return true;
      }
      // Refuse to remove the last owner. Locking every human out of the dashboard of a
      // server they are hosting is not a state anyone recovers from in a browser.
      if (role !== 'owner') {
        const owners = deps.accounts.listAll().filter((a) => a.dashboardRole === 'owner');
        if (owners.length <= 1 && owners[0]?.name.toLowerCase() === name.toLowerCase()) {
          json(res, 400, { error: 'this is the only owner, promote someone else first' });
          return true;
        }
      }
      if (!await deps.accounts.setDashboardRole(name, role as DashboardRole | undefined)) {
        json(res, 404, { error: 'no such account' }); return true;
      }
      if (role === undefined) deps.sessions.revokeAccount(name.toLowerCase());
      await deps.accounts.flush();
      log('info', 'admin.role_changed', { account: name.toLowerCase(), role: role ?? null, by: ctx.accountKey });
      json(res, 200, { ok: true });
      return true;
    }
    if (method === 'POST' && path === '/admin/api/accounts/delete') {
      const ctx = await gate(req, res, auth, 'owner');
      if (!ctx) return true;
      const body = await readJson<{ name?: string; confirm?: string }>(req, res);
      if (body === undefined) return true;
      const name = String(body.name ?? '');
      // Type-to-confirm. Erasure is irreversible and this is a browser, where a stray click
      // is a real failure mode; making the operator retype the name is the cheapest possible
      // guard against deleting the wrong row.
      if (String(body.confirm ?? '') !== name) {
        json(res, 400, { error: 'confirmation did not match the account name' });
        return true;
      }
      const result = await deps.deleteAccount(name.toLowerCase());
      if (result.ok) {
        deps.sessions.revokeAccount(name.toLowerCase());
        log('warn', 'admin.account_deleted', { account: name.toLowerCase(), by: ctx.accountKey });
      }
      json(res, result.ok ? 200 : 400, result);
      return true;
    }

    // --- sessions ---------------------------------------------------------------------------------
    if (method === 'GET' && path === '/admin/api/sessions') {
      if (!await gate(req, res, auth, 'owner')) return true;
      json(res, 200, { sessions: deps.sessions.list() });
      return true;
    }
    if (method === 'POST' && path === '/admin/api/sessions/revoke') {
      const ctx = await gate(req, res, auth, 'owner');
      if (!ctx) return true;
      const body = await readJson<{ id?: string }>(req, res);
      if (body === undefined) return true;
      const ok = deps.sessions.revokeById(String(body.id ?? ''));
      if (ok) log('info', 'admin.session_revoked', { by: ctx.accountKey });
      json(res, ok ? 200 : 404, { ok });
      return true;
    }

    // --- two-factor, always for your OWN account only -----------------------------------------------
    // Deliberately no "enrol someone else": a second factor you did not create yourself is
    // not a second factor, it is a credential somebody else holds.
    if (method === 'POST' && path === '/admin/api/totp/enroll') {
      const ctx = await gate(req, res, auth, 'viewer');
      if (!ctx) return true;
      if (ctx.viaSharedToken) { json(res, 400, { error: 'shared-token sessions have no account' }); return true; }
      const secret = generateSecret();
      pendingTotp.set(ctx.accountKey, { secret, at: Date.now() });
      json(res, 200, { secret, uri: totpUri(secret, ctx.accountName) });
      return true;
    }
    if (method === 'POST' && path === '/admin/api/totp/confirm') {
      const ctx = await gate(req, res, auth, 'viewer');
      if (!ctx) return true;
      const body = await readJson<{ code?: string }>(req, res);
      if (body === undefined) return true;
      const pending = pendingTotp.get(ctx.accountKey);
      if (!pending || Date.now() - pending.at > 10 * 60_000) {
        json(res, 400, { error: 'enrolment expired, start again' }); return true;
      }
      // Proving one live code before saving is what stops an operator locking themselves out
      // with a secret their phone never actually accepted.
      if (!verifyTotp(pending.secret, String(body.code ?? ''))) {
        json(res, 400, { error: 'that code did not match, check your phone\'s clock' }); return true;
      }
      await deps.accounts.setTotpSecret(ctx.accountName, pending.secret);
      await deps.accounts.flush();
      pendingTotp.delete(ctx.accountKey);
      log('info', 'admin.totp_enrolled', { account: ctx.accountKey });
      json(res, 200, { ok: true });
      return true;
    }
    if (method === 'POST' && path === '/admin/api/totp/disable') {
      const ctx = await gate(req, res, auth, 'viewer');
      if (!ctx) return true;
      const body = await readJson<{ password?: string }>(req, res);
      if (body === undefined) return true;
      // Re-authenticate: an unattended open dashboard must not be enough to strip the second
      // factor off the account.
      if (!await deps.accounts.verifyLogin(ctx.accountName, String(body.password ?? ''))) {
        json(res, 401, { error: 'password did not match' }); return true;
      }
      await deps.accounts.setTotpSecret(ctx.accountName, undefined);
      await deps.accounts.flush();
      log('warn', 'admin.totp_disabled', { account: ctx.accountKey });
      json(res, 200, { ok: true });
      return true;
    }

    // --- lifecycle -----------------------------------------------------------------------------------
    if (method === 'POST' && path === '/admin/api/maintenance') {
      const ctx = await gate(req, res, auth, 'owner');
      if (!ctx) return true;
      const body = await readJson<{ on?: boolean; message?: string }>(req, res);
      if (body === undefined) return true;
      const on = !!body.on;
      deps.maintenance.set(on, String(body.message ?? '').slice(0, 200));
      log('warn', 'admin.maintenance', { on, by: ctx.accountKey });
      json(res, 200, { ok: true, maintenance: deps.maintenance.get() });
      return true;
    }
    if (method === 'POST' && path === '/admin/api/restart') {
      const ctx = await gate(req, res, auth, 'owner');
      if (!ctx) return true;
      log('warn', 'admin.restart', { by: ctx.accountKey });
      // Answer BEFORE going down, or the page sees a dropped socket and reports a failure
      // for something that actually worked.
      json(res, 200, { ok: true });
      setTimeout(() => deps.restart(`admin dashboard (${ctx.accountKey})`), 250).unref();
      return true;
    }
    if (method === 'GET' && path === '/admin/api/export') {
      const ctx = await gate(req, res, auth, 'owner');
      if (!ctx) return true;
      log('warn', 'admin.export', { by: ctx.accountKey });
      await deps.exportData(res);
      return true;
    }

    // NO in-dashboard markdown renderer, deliberately. The plan called for one that would
    // serve this repo's docs; building it meant vendoring a markdown parser to display
    // PROTOCOL.md and STATUS.md, which are written for the next engineer, not for someone
    // hosting a server. The documentation an operator actually needs is the per-field help
    // next to the field (help.ts) and the troubleshooting on the Help page, both already
    // here, neither requiring a parser. The deep material stays on GitHub, linked.

    json(res, 404, { error: 'not found' });
    return true;
  };
}

/** Un-confirmed TOTP secrets, in memory only: an enrolment that is never confirmed should
 *  evaporate rather than sit on an account as a half-configured second factor. */
const pendingTotp = new Map<string, { secret: string; at: number }>();
