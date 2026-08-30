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
import { DASHBOARD_ROLES, validAccountName } from '../../core/accounts';
import type { AdminSessionStore } from '../../auth/identities';
import type { IpRateLimiter } from '../ratelimit';
import { clientIp } from '../http';
import { log } from '../../log';
import { json, readJson } from './util';
import { gate, passwordLogin, passwordProblem, resolveAuth, type AuthDeps } from './auth';
import { serveWebFile } from './static';
import { generateSecret, totpUri, verifyTotp } from './totp';
import { settingsView, applySection, applyWizard, type WizardAnswers } from './api-settings';
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

  // --- the original moderation surface, unchanged ---
  overview(): unknown;
  reports(limit: number): Promise<unknown>;
  action(kind: string, target: string, detail: string): Promise<{ ok: boolean; message: string }>;

  // --- new capability, supplied by server.ts so this module stays free of game types ---
  /** Run one ADMIN_COMMANDS entry as `actor`. Returns the same text the chat path returns. */
  runCommand(actor: { accountKey: string; name: string; rank: number }, line: string):
    Promise<{ ok: boolean; message: string }>;
  /** Which commands exist, and what each needs — drives the console UI. */
  commandCatalog(): { name: string; usage: string; help: string; minRank: number; inGameOnly?: boolean }[];
  recentLogs(limit: number, filter: string): LogEntry[];
  metricsSnapshot(): unknown;
  gameDataDir: string;
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

export function adminRoutes(deps: AdminDeps) {
  const auth: AuthDeps = {
    sharedToken: deps.sharedToken,
    accounts: deps.accounts,
    sessions: deps.sessions,
    loginLimiter: deps.loginLimiter,
    apiLimiter: deps.apiLimiter,
  };

  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const path = url.pathname;
    if (path !== '/admin' && !path.startsWith('/admin/')) return false;

    const method = req.method ?? 'GET';

    // --- the page and its assets ---------------------------------------------------------
    // Served unauthenticated on purpose: the HTML and JS can do nothing without a token, and
    // a login form that requires a login to fetch is not a login form. Unlike the old
    // dashboard this is NOT gated on a token being configured — accounts are the way in now,
    // and hiding the page would hide first-run setup, which is the whole point.
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
      const firstRun = !deps.accounts.hasDashboardOwner();
      const ctx = await resolveAuth(req, auth);
      json(res, 200, {
        firstRun,
        authed: !!ctx,
        role: ctx?.role ?? null,
        name: ctx?.accountName ?? null,
        maintenance: deps.maintenance.get(),
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
    // Reachable without any credential, and ONLY while no dashboard owner exists. The moment
    // one does, this route stops existing — otherwise it would be a permanent open door to
    // making yourself an owner.
    if (method === 'POST' && path === '/admin/api/setup/owner') {
      if (deps.accounts.hasDashboardOwner()) {
        json(res, 409, { error: 'setup already completed' });
        return true;
      }
      if (!deps.loginLimiter.allow(clientIp(req))) {
        json(res, 429, { error: 'too many attempts, wait a minute' });
        return true;
      }
      const body = await readJson<{ name?: string; password?: string }>(req, res);
      if (body === undefined) return true;
      const name = String(body.name ?? '').trim();
      const password = String(body.password ?? '');
      if (!validAccountName(name)) {
        json(res, 400, { error: 'name must be 2-24 characters: letters, numbers, spaces, _ or -' });
        return true;
      }
      const weak = passwordProblem(password, name);
      if (weak) { json(res, 400, { error: `password ${weak}` }); return true; }

      // An account may already exist (someone played first, then set the dashboard up).
      // Promote it rather than refusing — but only because we have already established that
      // NO owner exists yet, so this is the genuine first-run window.
      const existing = await deps.accounts.get(name);
      if (!existing) {
        const created = await deps.accounts.register(name, password);
        if (typeof created === 'string') {
          json(res, 400, { error: created === 'exists' ? 'name taken' : 'invalid name' });
          return true;
        }
      }
      await deps.accounts.setDashboardRole(name, 'owner');
      const key = name.toLowerCase();
      deps.accounts.setRank(name, 3); // in-game parity: the first owner is an owner in-world too
      // Also record them in [admin].owners so the every-boot promotion keeps them rank 3 even
      // if the account cache is cold. Failure here is not fatal — the role is what gates the
      // dashboard — so a read-only data dir still yields a usable login.
      applyWizard(deps.dataDir, { owners: [name] }, deps.sharedDir);
      await deps.accounts.flush();
      const token = deps.sessions.mint(key, clientIp(req));
      log('info', 'admin.setup_owner', { account: key });
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
      json(res, 200, deps.overview());
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
      const result = await deps.action(
        String(body.kind ?? ''), String(body.target ?? ''), String(body.detail ?? ''),
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
      const rank = ctx.role === 'owner' ? 3 : ctx.role === 'moderator' ? 1 : 0;
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
      log('info', 'admin.config_changed', { section, by: ctx.accountKey, keys: Object.keys(body) });
      json(res, 200, { ok: true, restartRequired: true });
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
      log('info', 'admin.setup_applied', { by: ctx.accountKey, mode: body.deploymentMode });
      json(res, 200, { ok: true, restartRequired: true });
      return true;
    }

    // --- mods ---------------------------------------------------------------------------------
    if (method === 'GET' && path === '/admin/api/mods') {
      if (!await gate(req, res, auth, 'viewer')) return true;
      json(res, 200, { ...(modsView(deps.gameDataDir, deps.dataDir) as object), writable: gameDataWritable(deps.gameDataDir) });
      return true;
    }
    // Upload streams straight to disk, so it must NOT go through readJson's buffering — a
    // 400 MB archive is not a JSON body. Owner only: this writes files the engine will load.
    if (method === 'POST' && path === '/admin/api/mods/upload') {
      const ctx = await gate(req, res, auth, 'owner');
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
          json(res, 400, { error: 'this is the only owner — promote someone else first' });
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
        json(res, 400, { error: 'that code did not match — check your phone\'s clock' }); return true;
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
    // next to the field (help.ts) and the troubleshooting on the Help page — both already
    // here, neither requiring a parser. The deep material stays on GitHub, linked.

    json(res, 404, { error: 'not found' });
    return true;
  };
}

/** Un-confirmed TOTP secrets, in memory only: an enrolment that is never confirmed should
 *  evaporate rather than sit on an account as a half-configured second factor. */
const pendingTotp = new Map<string, { secret: string; at: number }>();
