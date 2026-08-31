// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase B SSO storage: the (iss,sub) -> account index, the short-lived login ticket that
// carries a browser-side SSO result over to the WebSocket, and the live-session index the
// account-linking route authenticates against.
//
// The account store is one JSON file per lowercased name with no secondary index, so a
// provider subject has no home there. It gets its own directory: <dataDir>/identities/,
// one file per identity named sha256(iss \n sub) — a content-addressed name is the only
// way to get a safe filename out of two attacker-influenced strings.
//
// PRIVACY.md: an (iss,sub) pair IS personal data (it identifies a person at a provider).
// It is erased with the account by persist/erase.ts.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../persist/sqlite';
import { validAccountName, validEmail, type AccountStore } from '../core/accounts';
import type { Identity, ProviderId } from './oidc';
import { log } from '../log';

export function identityKey(iss: string, sub: string): string {
  return createHash('sha256').update(`${iss}\n${sub}`).digest('hex');
}

export interface IdentityRecord {
  iss: string;
  sub: string;
  accountKey: string; // lowercased account name — the account store's key
  linkedAt: string;
}

const IDENTITY_MIGRATIONS = [
  {
    name: '001-identities',
    up: (db: DatabaseSync) => {
      db.exec(`CREATE TABLE identities (
        key        TEXT PRIMARY KEY,   -- sha256(iss|sub); never the raw subject
        iss        TEXT NOT NULL,
        sub        TEXT NOT NULL,
        accountKey TEXT NOT NULL,
        linkedAt   TEXT NOT NULL
      )`);
      // listForAccount and erasure both look up by account, not by identity key.
      db.exec('CREATE INDEX identities_account ON identities (accountKey)');
    },
  },
];

export class IdentityStore {
  private readonly db: DatabaseSync;
  private readonly byKey = new Map<string, IdentityRecord>();

  constructor(dataDir: string) {
    this.db = openDb(join(dataDir, 'identities.db'), IDENTITY_MIGRATIONS);
    this.load();
  }

  // Loaded once at boot: the whole index must be authoritative before the listener opens,
  // exactly like the ban list — a missed entry would silently create a SECOND account for
  // a player who already has one.
  private load(): void {
    const rows = this.db.prepare('SELECT key, iss, sub, accountKey, linkedAt FROM identities').all() as
      { key: string; iss: string; sub: string; accountKey: string; linkedAt: string }[];
    for (const r of rows) {
      this.byKey.set(r.key, { iss: r.iss, sub: r.sub, accountKey: r.accountKey, linkedAt: r.linkedAt });
    }
  }

  get(iss: string, sub: string): IdentityRecord | undefined {
    return this.byKey.get(identityKey(iss, sub));
  }

  async bind(iss: string, sub: string, accountKey: string): Promise<void> {
    const key = identityKey(iss, sub);
    const rec: IdentityRecord = { iss, sub, accountKey, linkedAt: new Date().toISOString() };
    this.byKey.set(key, rec);
    // Written through immediately (not via a dirty queue): losing this write means the
    // next login creates a duplicate account. node:sqlite commits synchronously.
    this.db
      .prepare('INSERT OR REPLACE INTO identities (key, iss, sub, accountKey, linkedAt) VALUES (?, ?, ?, ?, ?)')
      .run(key, rec.iss, rec.sub, rec.accountKey, rec.linkedAt);
  }

  listForAccount(accountKey: string): IdentityRecord[] {
    return [...this.byKey.values()].filter((r) => r.accountKey === accountKey);
  }
}

// ------------------------------------------------------------- display names

const PROVIDER_LABEL: Record<ProviderId, string> = {
  discord: 'Discord',
  google: 'Google',
  microsoft: 'Microsoft',
  custom: 'User',
};

// Never the email — it is mutable, it is not ours to publish in a player list, and it is
// exactly the identifier we refuse to key on. Anything email-shaped is dropped outright,
// then the hint is reduced to the account charset.
function sanitizeHint(hint: string | undefined): string {
  if (!hint || hint.includes('@')) return '';
  const cleaned = hint
    .replace(/[^A-Za-z0-9_ -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24)
    .trim();
  return validAccountName(cleaned) ? cleaned : '';
}

// A display name that cannot collide with an existing account. The provider hint is only
// a suggestion: whoever registered a password account with that name owns it, so an SSO
// arrival gets a suffix instead of stealing it.
async function pickDisplayName(accounts: AccountStore, provider: ProviderId, hint: string | undefined): Promise<string> {
  const base = sanitizeHint(hint);
  if (base !== '' && !(await accounts.get(base))) return base;
  if (base !== '') {
    for (let n = 2; n <= 99; n++) {
      const suffix = `-${n}`;
      const candidate = `${base.slice(0, 24 - suffix.length).trim()}${suffix}`;
      if (validAccountName(candidate) && !(await accounts.get(candidate))) return candidate;
    }
  }
  // Fallback: label + random. 6 hex is 16.7M per label, and we retry, so a collision here
  // is not a failure mode worth a second index.
  for (let i = 0; i < 20; i++) {
    const candidate = `${PROVIDER_LABEL[provider]}-${randomBytes(3).toString('hex')}`;
    if (!(await accounts.get(candidate))) return candidate;
  }
  throw new Error('could not allocate a free display name');
}

// Resolve a verified identity to an account, creating one on first sight. Returns the
// account plus whether it was just created (the caller logs it).
export async function resolveSsoAccount(
  accounts: AccountStore,
  identities: IdentityStore,
  provider: ProviderId,
  identity: Identity,
): Promise<{ accountKey: string; accountName: string; created: boolean }> {
  // Capture a provider-verified email as the account's contact address, but never overwrite
  // one the user already has (their onboarding choice wins). Awaited-flushed by the caller.
  const adoptEmail = async (accountKey: string): Promise<void> => {
    if (!identity.email) return;
    // VALIDATE, even though it came from a provider. Every other setEmail caller runs this
    // check; this path skipped it because the value arrives from an OIDC `email` claim and
    // that felt trustworthy. It is not: [auth.custom] accepts any issuer an operator points
    // it at, so the claim is attacker-controlled on a hostile or compromised provider. It
    // then flows into an SMTP envelope on the password-reset path, where a line break buys
    // an extra recipient. Two guards now — here and at the sink in admin/notify.ts.
    if (!validEmail(identity.email)) {
      log('warn', 'auth.email_claim_rejected', { iss: identity.iss });
      return;
    }
    const acc = await accounts.get(accountKey);
    if (acc && acc.email === undefined) {
      accounts.setEmail(acc, identity.email);
      await accounts.flush();
    }
  };

  const existing = identities.get(identity.iss, identity.sub);
  if (existing) {
    const account = await accounts.get(existing.accountKey);
    // The index outliving its account is an operator deleting accounts/<name>.json by
    // hand. Re-create rather than dead-end the player, keeping the same account key so
    // their character document (players/<key>.json) is still theirs.
    if (!account) {
      log('warn', 'identities.orphan_index', { accountKey: existing.accountKey, iss: identity.iss });
      const revived = await accounts.createSso(existing.accountKey);
      if (typeof revived === 'string') throw new Error(`cannot revive account ${existing.accountKey}: ${revived}`);
      await adoptEmail(existing.accountKey);
      return { accountKey: existing.accountKey, accountName: revived.name, created: true };
    }
    await adoptEmail(existing.accountKey);
    return { accountKey: existing.accountKey, accountName: account.name, created: false };
  }
  const name = await pickDisplayName(accounts, provider, identity.nameHint);
  const created = await accounts.createSso(name);
  if (typeof created === 'string') throw new Error(`cannot create SSO account ${name}: ${created}`);
  const accountKey = created.name.toLowerCase();
  await identities.bind(identity.iss, identity.sub, accountKey);
  await adoptEmail(accountKey);
  return { accountKey, accountName: created.name, created: true };
}

// ------------------------------------------------------------- login tickets

export interface LoginTicket {
  accountKey: string;
  accountName: string;
  expiresAt: number;
}

// The one-time credential that carries "this browser proved it owns (iss,sub)" across to
// the game's WebSocket. Deliberately NOT the game session token and NOT a provider token:
// 32 random bytes, <=60 s, single use, and it grants nothing but one auth attempt.
const TICKET_MIGRATIONS = [
  {
    name: '001-tickets',
    up: (db: DatabaseSync) => {
      db.exec(`CREATE TABLE tickets (
        ticket      TEXT PRIMARY KEY,
        accountKey  TEXT NOT NULL,
        accountName TEXT NOT NULL,
        expiresAt   INTEGER NOT NULL
      )`);
      db.exec('CREATE INDEX tickets_expiry ON tickets (expiresAt)');
    },
  },
];

export class LoginTicketStore {
  private readonly tickets = new Map<string, LoginTicket>();
  private readonly timer: NodeJS.Timeout;
  // F3 cross-process: the gateway mints a ticket, a DIFFERENT world process claims it. With a
  // sharedDir set, tickets also live in <sharedDir>/tickets.db so any process sharing that dir
  // can verify one. Single use is enforced by the DELETE on claim — whoever deletes the row
  // first wins, which is the same race the unlink used to settle but decided by the database.
  private readonly db?: DatabaseSync;

  // 15 min, not 60 s: the ticket is redeemed by the MP client AFTER the game engine has loaded
  // its content (streamed retail data can take minutes on a first play), so a 60 s ticket was
  // always expired by connect time and the client fell back to the password ladder — which an
  // SSO-only server refuses. Still single-use and fragment-delivered, so the longer TTL is cheap.
  constructor(private readonly ttlMs = 15 * 60_000, sharedDir?: string) {
    if (sharedDir) {
      // LOUD on failure. Without this database a world cannot see tickets minted by the front
      // door, so every SSO login to it fails with "expired or already used" — and swallowing
      // the error made that indistinguishable from a genuinely stale ticket.
      try {
        this.db = openDb(join(sharedDir, 'tickets.db'), TICKET_MIGRATIONS);
      } catch (err) {
        log('error', 'tickets.store_unavailable', { dir: sharedDir, error: String(err) });
      }
    }
    this.timer = setInterval(() => this.sweep(), 30_000);
    this.timer.unref();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [t, v] of this.tickets) if (v.expiresAt <= now) this.tickets.delete(t);
    try {
      this.db?.prepare('DELETE FROM tickets WHERE expiresAt <= ?').run(now);
    } catch { /* another process may be sweeping the same rows */ }
  }

  mint(accountKey: string, accountName: string): string {
    // Sweep expired rows first — /auth/ticket has no rate limiter and this INSERTs into the
    // SHARED db, so an authed client in a loop grew it without bound. Same idiom as
    // LockerSessionStore.mint, which always swept.
    try { this.db?.prepare('DELETE FROM tickets WHERE expiresAt < ?').run(Date.now()); } catch { /* best effort */ }
    for (const [k, v] of this.tickets) { if (v.expiresAt <= Date.now()) this.tickets.delete(k); }
    const ticket = randomBytes(32).toString('base64url'); // 256 bits: unguessable within the TTL
    const rec: LoginTicket = { accountKey, accountName, expiresAt: Date.now() + this.ttlMs };
    this.tickets.set(ticket, rec);
    try {
      this.db?.prepare('INSERT OR REPLACE INTO tickets (ticket, accountKey, accountName, expiresAt) VALUES (?, ?, ?, ?)')
        .run(ticket, rec.accountKey, rec.accountName, rec.expiresAt);
    } catch { /* in-process memory still works */ }
    return ticket;
  }

  /** Read a ticket WITHOUT spending it. Exists so the caller can run its refusals — world
   *  access, the chargen gate — before committing the credential. Consuming first meant any
   *  refusal after the claim burned the ticket, and the client's reconnect ladder then retried
   *  a credential that could never work again: one click on Public produced six identical
   *  "login ticket expired or already used" refusals and a switch that silently did nothing.
   *  ALWAYS pair with claim() on the success path; a peek alone is not single-use. */
  peek(ticket: string): LoginTicket | undefined {
    // RESERVED, not merely read. Two connections peeking the same ticket in the same instant
    // would both have proceeded and both been admitted, which is single-use in name only. The
    // in-memory entry is removed here so the second peek finds nothing; the DB row survives
    // until claim(), so a refusal can still hand the ticket back (see restore below).
    let found = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!found && this.db) {
      try {
        const row = this.db
          .prepare('SELECT accountKey, accountName, expiresAt FROM tickets WHERE ticket = ?')
          .get(ticket) as LoginTicket | undefined;
        if (row) found = { accountKey: row.accountKey, accountName: row.accountName, expiresAt: Number(row.expiresAt) };
      } catch { /* not here */ }
    }
    return found && found.expiresAt > Date.now() ? found : undefined;
  }

  /** Give back a ticket reserved by peek() but never committed — the join was refused, so the
   *  player should still be able to use it (to go back where they came from, or to retry).
   *  Without this the reservation above would turn every refusal into a spent credential,
   *  which is the failure peek() exists to prevent. */
  restore(ticket: string): void {
    if (!this.db) return;
    try {
      const row = this.db
        .prepare('SELECT accountKey, accountName, expiresAt FROM tickets WHERE ticket = ?')
        .get(ticket) as LoginTicket | undefined;
      if (row && Number(row.expiresAt) > Date.now()) {
        this.tickets.set(ticket, {
          accountKey: row.accountKey, accountName: row.accountName, expiresAt: Number(row.expiresAt),
        });
      }
    } catch { /* the row is gone: nothing to give back */ }
  }

  // Single use: removed on the first claim, valid or not. Falls through to the shared DB when
  // the ticket was minted by another process (the gateway).
  claim(ticket: string): LoginTicket | undefined {
    let found = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!found && this.db) {
      try {
        const row = this.db
          .prepare('SELECT accountKey, accountName, expiresAt FROM tickets WHERE ticket = ?')
          .get(ticket) as LoginTicket | undefined;
        if (row) found = { accountKey: row.accountKey, accountName: row.accountName, expiresAt: Number(row.expiresAt) };
      } catch { /* not here */ }
    }
    try {
      this.db?.prepare('DELETE FROM tickets WHERE ticket = ?').run(ticket);
    } catch { /* already claimed/expired */ }
    return found && found.expiresAt > Date.now() ? found : undefined;
  }

  clear(): void {
    clearInterval(this.timer);
    this.tickets.clear();
  }
}

// ------------------------------------------------------------ live sessions

// sessionToken -> account, for the ONE thing that needs it over HTTP: proving who is
// asking to link a provider. Entries live exactly as long as the socket.
// Locker sessions: a browser needs to reach /locker/* to upload its game data BEFORE it
// can join any world, so this auth is separate from the game's WebSocket session. Minted
// at SSO login (auth/routes.ts) and delivered as an httpOnly cookie. TTL'd because it is a
// standing credential to a private data store; the game ticket is single-use and short,
// but the locker session must survive a multi-file upload.
export class LockerSessionStore {
  private readonly tokens = new Map<string, { accountKey: string; expiresAt: number }>();
  constructor(private readonly ttlMs = 24 * 60 * 60 * 1000) {}

  private readonly lastSeen = new Map<string, number>();

  mint(accountKey: string): string {
    this.sweep();
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(token, { accountKey, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  resolve(token: string): string | undefined {
    if (token === '') return undefined;
    const e = this.tokens.get(token);
    if (!e || e.expiresAt <= Date.now()) { if (e) this.tokens.delete(token); return undefined; }
    // WHO IS PLAYING, in the one deployment where nobody joins a world.
    //
    // The dashboard counts players from the WS roster, which is right for multiplayer and
    // structurally always zero for single player: the browser runs the engine itself and
    // never connects, so an operator watching their own session saw "0 in the world" while
    // playing it. Every authenticated locker and save request passes through here, so this is
    // the one place that sees that activity without a second mechanism to keep in step.
    //
    // A liveness signal, not a session: it says the account did something just now, so an
    // idle or closed tab stops counting on its own rather than lingering until a 24h token
    // expires.
    this.lastSeen.set(e.accountKey, Date.now());
    return e.accountKey;
  }

  /** Accounts that touched the locker within `withinMs`, most recently active first. */
  activeSince(withinMs: number): { account: string; lastSeen: number }[] {
    const cutoff = Date.now() - withinMs;
    return [...this.lastSeen]
      .filter(([, at]) => at > cutoff)
      .sort((a, b) => b[1] - a[1])
      .map(([account, at]) => ({ account, lastSeen: at }));
  }

  revokeAccount(accountKey: string): void {
    for (const [t, e] of [...this.tokens]) if (e.accountKey === accountKey) this.tokens.delete(t);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [t, e] of [...this.tokens]) if (e.expiresAt <= now) this.tokens.delete(t);
  }
}

/**
 * Browser sessions for the web dashboard. Same shape as LockerSessionStore, kept separate
 * rather than reused: this token governs SERVER CONTROL (config, mods, console) where that
 * one governs file uploads, so it wants its own TTL and its own revocation. Demoting an
 * admin must kill their dashboard session without touching their locker session.
 *
 * Opaque token in a JSON body, held client-side in sessionStorage — the convention every
 * other credential in this codebase already follows. No cookie, therefore no CSRF surface
 * to defend: a cross-site form post cannot attach a header the browser does not store.
 */
export class AdminSessionStore {
  private readonly tokens = new Map<string, AdminSession>();
  constructor(private readonly ttlMs = 4 * 60 * 60 * 1000) {}

  mint(accountKey: string, ip: string): string {
    this.sweep();
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.tokens.set(token, { accountKey, ip, issuedAt: now, expiresAt: now + this.ttlMs });
    return token;
  }

  resolve(token: string): string | undefined {
    if (token === '') return undefined;
    const e = this.tokens.get(token);
    if (!e || e.expiresAt <= Date.now()) { if (e) this.tokens.delete(token); return undefined; }
    return e.accountKey;
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }

  revokeAccount(accountKey: string): void {
    for (const [t, e] of [...this.tokens]) if (e.accountKey === accountKey) this.tokens.delete(t);
  }

  /** Live sessions for the dashboard's session manager. The token itself is never returned —
   *  an `id` derived from it is enough to revoke one, and a listing that leaked bearer
   *  credentials would turn "see who is logged in" into "become anyone who is logged in". */
  list(): (AdminSession & { id: string })[] {
    this.sweep();
    return [...this.tokens].map(([token, e]) => ({ ...e, id: sessionId(token) }));
  }

  revokeById(id: string): boolean {
    for (const [t] of [...this.tokens]) {
      if (sessionId(t) === id) { this.tokens.delete(t); return true; }
    }
    return false;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [t, e] of [...this.tokens]) if (e.expiresAt <= now) this.tokens.delete(t);
  }
}

export interface AdminSession {
  accountKey: string;
  ip: string;
  issuedAt: number;
  expiresAt: number;
}

/** Stable, non-reversible handle for a session token, safe to hand to a browser. */
function sessionId(token: string): string {
  return createHash('sha256').update(token).digest('base64url').slice(0, 16);
}

export class SessionIndex {
  private readonly byToken = new Map<string, { accountKey: string; accountName: string }>();

  add(token: string, accountKey: string, accountName: string): void {
    if (token !== '') this.byToken.set(token, { accountKey, accountName });
  }

  remove(token: string): void {
    this.byToken.delete(token);
  }

  // Constant-time over the candidate set is overkill for a Map lookup, but the token is a
  // bearer credential, so at least do not leak its prefix through an early-exit compare.
  get(token: string): { accountKey: string; accountName: string } | undefined {
    if (token === '') return undefined;
    const want = Buffer.from(token);
    for (const [known, value] of this.byToken) {
      const got = Buffer.from(known);
      if (got.length === want.length && timingSafeEqual(got, want)) return value;
    }
    return undefined;
  }
}
