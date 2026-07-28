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

import { mkdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readJson, writeJsonAtomic } from '../persist/atomicjson';
import { validAccountName, type AccountStore } from '../core/accounts';
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

export class IdentityStore {
  private readonly dir: string;
  private readonly byKey = new Map<string, IdentityRecord>();
  private loaded: Promise<void>;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'identities');
    mkdirSync(this.dir, { recursive: true });
    this.loaded = this.load();
  }

  // Loaded once at boot: the whole index must be authoritative before the listener opens,
  // exactly like the ban list — a missed entry would silently create a SECOND account for
  // a player who already has one.
  private async load(): Promise<void> {
    const names = await readdir(this.dir);
    for (const name of names) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      try {
        const rec = await readJson<IdentityRecord>(join(this.dir, name));
        if (rec && typeof rec.iss === 'string' && typeof rec.sub === 'string' && typeof rec.accountKey === 'string')
          this.byKey.set(name.slice(0, 64), rec);
      } catch (err) {
        // Loud: a corrupt identity file means a player who cannot log in, and silently
        // skipping it would instead hand them a brand new empty character.
        log('error', 'identities.load_failed', { file: name, error: String(err) });
      }
    }
  }

  ready(): Promise<void> {
    return this.loaded;
  }

  get(iss: string, sub: string): IdentityRecord | undefined {
    return this.byKey.get(identityKey(iss, sub));
  }

  async bind(iss: string, sub: string, accountKey: string): Promise<void> {
    const key = identityKey(iss, sub);
    const rec: IdentityRecord = { iss, sub, accountKey, linkedAt: new Date().toISOString() };
    this.byKey.set(key, rec);
    // Written through immediately (not via a dirty queue): losing this write means the
    // next login creates a duplicate account.
    await writeJsonAtomic(join(this.dir, `${key}.json`), rec);
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
      return { accountKey: existing.accountKey, accountName: revived.name, created: true };
    }
    return { accountKey: existing.accountKey, accountName: account.name, created: false };
  }
  const name = await pickDisplayName(accounts, provider, identity.nameHint);
  const created = await accounts.createSso(name);
  if (typeof created === 'string') throw new Error(`cannot create SSO account ${name}: ${created}`);
  const accountKey = created.name.toLowerCase();
  await identities.bind(identity.iss, identity.sub, accountKey);
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
export class LoginTicketStore {
  private readonly tickets = new Map<string, LoginTicket>();
  private readonly timer: NodeJS.Timeout;

  // 15 min, not 60 s: the ticket is redeemed by the MP client AFTER the game engine has loaded
  // its content (streamed retail data can take minutes on a first play), so a 60 s ticket was
  // always expired by connect time and the client fell back to the password ladder — which an
  // SSO-only server refuses. Still single-use and fragment-delivered, so the longer TTL is cheap.
  constructor(private readonly ttlMs = 15 * 60_000) {
    this.timer = setInterval(() => this.sweep(), 30_000);
    this.timer.unref();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [t, v] of this.tickets) if (v.expiresAt <= now) this.tickets.delete(t);
  }

  mint(accountKey: string, accountName: string): string {
    const ticket = randomBytes(32).toString('base64url'); // 256 bits: unguessable within 60 s
    this.tickets.set(ticket, { accountKey, accountName, expiresAt: Date.now() + this.ttlMs });
    return ticket;
  }

  // Single use: deleted on the first claim, valid or not.
  claim(ticket: string): LoginTicket | undefined {
    const found = this.tickets.get(ticket);
    if (!found) return undefined;
    this.tickets.delete(ticket);
    return found.expiresAt > Date.now() ? found : undefined;
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
    return e.accountKey;
  }

  revokeAccount(accountKey: string): void {
    for (const [t, e] of [...this.tokens]) if (e.accountKey === accountKey) this.tokens.delete(t);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [t, e] of [...this.tokens]) if (e.expiresAt <= now) this.tokens.delete(t);
  }
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
