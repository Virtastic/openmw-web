// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Account store: <dataDir>/accounts.db, argon2id (OWASP 2024 baseline: m=19456 KiB, t=2,
// p=1). Mutations write through the dirty queue; flush() drains it (SIGUSR1 / shutdown /
// 30 s timer).

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import type { DatabaseSync } from 'node:sqlite';
import { readdir } from 'node:fs/promises';
import { openDb, tx } from '../persist/sqlite';

const ACCOUNT_MIGRATIONS = [
  {
    name: '001-accounts',
    up: (db: DatabaseSync) => {
      // Keyed by `key` (the lowercased login name). The JSON layout made that key a FILENAME,
      // which for an SSO account is the person's real name sitting in a directory listing
      // ("accounts/jane smith.json"). A column has no such problem: the display name is
      // ordinary data and nothing about the storage exposes it.
      db.exec(`CREATE TABLE accounts (key TEXT PRIMARY KEY, doc TEXT NOT NULL)`);
      // Username uniqueness used to be "a file exists at usernames/<handle>.json". A PRIMARY
      // KEY is the real constraint: the database refuses a duplicate outright instead of a
      // racing caller winning by creating a file first.
      db.exec(`CREATE TABLE usernames (
        username      TEXT PRIMARY KEY,
        accountKey    TEXT NOT NULL,
        reservedUntil TEXT
      )`);
      db.exec('CREATE INDEX usernames_account ON usernames (accountKey)');
    },
  },
];
import { log } from '../log';

// A character slot. The character — not the account — owns a PlayerDoc (inventory, stats,
// journal), and its id is the PlayerStore key. Lives on the SHARED account record so the
// same characters exist in every world; each world keeps only that character's position.
export interface CharacterSummary {
  id: string; // PlayerStore key; also the future private-world id
  name: string; // display name in-world
  createdAt: string;
  lastPlayedAt: string;
  // True once Morrowind's character creation (race/class/sign) FINISHED for this slot. Until
  // then the slot is provisional. Player state is never destroyed on the strength of this
  // flag — an in-progress creation resumes in place — but the flag gates the multiplayer
  // features that make no sense before a character exists.
  completed?: boolean;
}

export interface Account {
  name: string; // display casing as registered
  // Phase B: optional. An SSO-only account has no password at all — not an empty hash, not
  // a hash of a random string: absent. verifyLogin() refuses it cleanly.
  pwHash?: string;
  createdAt: string;
  lastSeenAt: string;
  rank: number; // 0 = player, >=1 = admin (seeded by editing the JSON by hand in M0)
  banned?: boolean;
  // Absent on pre-slot accounts; the first authed session migrates them to one character.
  characters?: CharacterSummary[];
  // Onboarding profile. email is CONTACT data: it must never appear in any wire payload
  // or peer-visible surface — only the owner's own profile view and the CRM hook see it.
  // username is the unique public handle shown everywhere in-game (nametags, chat,
  // friends, admin views); account `name` remains the login identifier only.
  email?: string;
  username?: string;
  marketingOptIn?: boolean;
  usernameChangedAt?: string; // rename rate-limit anchor
}

export const MAX_CHARACTERS = 8;

// Placeholder for a slot auto-created before character creation has run. Public (tile label,
// PlayerAppearance, other players' screens), so never derived from the account — an SSO
// account name is the person's real name.
export const DEFAULT_CHARACTER_NAME = 'Adventurer';
// Every label a slot can carry before chargen names it. Two paths create slots (auth
// auto-create and the launcher's "+ New character" tile) and they used different words, so a
// rename that knew only one left half the characters showing a placeholder forever.
const PLACEHOLDER_NAMES = new Set([DEFAULT_CHARACTER_NAME.toLowerCase(), 'new character']);

// Public handle rules: tighter than account names (no spaces — it is a handle, not a
// paragraph), case-insensitively unique, and never something that reads as staff.
const USERNAME_RE = /^[A-Za-z0-9]{3,20}$/; // letters and numbers only — the public handle
const USERNAME_BLOCKLIST = new Set([
  'admin', 'administrator', 'moderator', 'mod', 'staff', 'gm', 'gamemaster',
  'system', 'server', 'owner', 'operator', 'support', 'virtastic', 'openmw',
]);
// Deliberately loose: the point is catching typos ("a@b"), not RFC 5322 conformance.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const USERNAME_RENAME_COOLDOWN_MS = 7 * 24 * 3600 * 1000;
// After a rename the OLD handle stays reserved for its previous owner, so nobody can
// snatch it and impersonate them while friends still know them by it.
export const USERNAME_RESERVE_MS = 30 * 24 * 3600 * 1000;

export function validUsername(username: string): 'ok' | 'badformat' | 'reserved-word' {
  if (!USERNAME_RE.test(username)) return 'badformat';
  if (USERNAME_BLOCKLIST.has(username.toLowerCase())) return 'reserved-word';
  return 'ok';
}

export function validEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

const ARGON2_OPTS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const NAME_RE = /^[A-Za-z0-9_ -]{2,24}$/;

export function validAccountName(name: string): boolean {
  return NAME_RE.test(name);
}

export class AccountStore {
  private cache = new Map<string, Account>(); // key = nameLower
  private dirty = new Set<string>();
  private flushTimer: NodeJS.Timeout;

  private readonly db: DatabaseSync;
  private readonly keysOnDisk = new Set<string>(); // existsNow() without touching the disk

  constructor(dataDir: string) {
    this.db = openDb(join(dataDir, 'accounts.db'), ACCOUNT_MIGRATIONS);
    this.flushTimer = setInterval(() => void this.flush(), 30_000);
    this.flushTimer.unref();
    for (const r of this.db.prepare('SELECT key FROM accounts').all() as { key: string }[]) {
      this.keysOnDisk.add(r.key);
    }
  }

  // Write-through for the registration paths. An account that exists in memory but not in
  // storage means a crash right after signup loses it, and anything that looks the account up
  // from outside the process (erasure, another world) finds nothing.
  private writeNow(key: string, account: Account): void {
    this.db.prepare('INSERT OR REPLACE INTO accounts (key, doc) VALUES (?, ?)')
      .run(key, JSON.stringify(account));
    this.keysOnDisk.add(key);
  }

  // Sync lookups for user-initiated, low-frequency actions (Phase C friend requests and
  // blocks). Answered from the key set loaded at boot, so no query and nothing on a hot path
  // is tempted to block.
  existsNow(name: string): boolean {
    const key = name.toLowerCase();
    return this.cache.has(key) || this.keysOnDisk.has(key);
  }

  // Display casing for an account that may be offline; undefined when it is not cached.
  cachedByKey(key: string): Account | undefined {
    return this.cache.get(key);
  }

  async get(name: string): Promise<Account | undefined> {
    const key = name.toLowerCase();
    const cached = this.cache.get(key);
    if (cached) return cached;
    const row = this.db.prepare('SELECT doc FROM accounts WHERE key = ?').get(key) as
      { doc: string } | undefined;
    const loaded = row ? (JSON.parse(row.doc) as Account) : undefined;
    if (loaded) this.cache.set(key, loaded);
    return loaded;
  }

  // 'exists' | 'badname' | the new account. Uniqueness is case-insensitive.
  async register(name: string, password: string): Promise<Account | 'exists' | 'badname'> {
    if (!validAccountName(name)) return 'badname';
    if (await this.get(name)) return 'exists';
    const now = new Date().toISOString();
    const account: Account = {
      name,
      pwHash: await hash(password, ARGON2_OPTS),
      createdAt: now,
      lastSeenAt: now,
      rank: 0,
    };
    const key = name.toLowerCase();
    this.cache.set(key, account);
    this.writeNow(key, account);
    return account;
  }

  // Phase B: an account created through SSO, with no password. The caller has ALREADY
  // checked that the name is free and picked one that cannot collide.
  async createSso(name: string): Promise<Account | 'exists' | 'badname'> {
    if (!validAccountName(name)) return 'badname';
    if (await this.get(name)) return 'exists';
    const now = new Date().toISOString();
    const account: Account = { name, createdAt: now, lastSeenAt: now, rank: 0 };
    const key = name.toLowerCase();
    this.cache.set(key, account);
    this.writeNow(key, account);
    return account;
  }

  // null on unknown account, an SSO-only account, or a wrong password (indistinguishable
  // to the caller by design). The pwHash guard is what keeps a password attempt against an
  // SSO-only account a clean refusal instead of an argon2 throw.
  async verifyLogin(name: string, password: string): Promise<Account | null> {
    const account = await this.get(name);
    if (!account || !account.pwHash) return null;
    return (await verify(account.pwHash, password)) ? account : null;
  }

  // Character slots. Mutations go through the dirty queue; callers hold a cached account
  // (every auth path has just awaited get()).
  //
  // createCharacter is also the pre-slot migration step: an account with no characters[]
  // gets its first slot named after the account, and the caller adopts any legacy
  // account-keyed PlayerDoc under the new character id.
  createCharacter(account: Account, name: string): CharacterSummary | 'full' {
    const chars = (account.characters ??= []);
    if (chars.length >= MAX_CHARACTERS) return 'full';
    const now = new Date().toISOString();
    const char: CharacterSummary = {
      // 'c' + 24 hex chars: never collides with a legacy account-keyed doc (those are
      // lowercased account names, capped at 24 chars total and allowed spaces).
      id: `c${randomBytes(12).toString('hex')}`,
      name,
      createdAt: now,
      lastPlayedAt: now,
    };
    chars.push(char);
    this.dirty.add(account.name.toLowerCase());
    return char;
  }

  // Marks creation finished for a slot. Written through IMMEDIATELY rather than riding the
  // 30 s dirty sweep: finish creation, refresh inside that window, and the flag never reached
  // disk — the slot then looked like an unfinished creation on the next login. It fires once
  // per character, so the cost is nothing.
  completeCharacter(account: Account, charId: string): void {
    const char = account.characters?.find((c) => c.id === charId);
    if (!char || char.completed) return;
    char.completed = true;
    this.dirty.add(account.name.toLowerCase());
    void this.flush();
  }

  // Delete a character slot. The slot record goes; the character's PlayerDoc is erased by the
  // caller (it owns the PlayerStore). Returns false when the id does not belong to this
  // account — never trust a client-supplied id to name someone else's character.
  deleteCharacter(account: Account, charId: string): boolean {
    const chars = account.characters;
    if (!chars) return false;
    const i = chars.findIndex((c) => c.id === charId);
    if (i < 0) return false;
    chars.splice(i, 1);
    this.dirty.add(account.name.toLowerCase());
    void this.flush();
    return true;
  }

  // Chargen is where a character is really named; the name reaches the server in the
  // appearance. Only ever replaces the PLACEHOLDER, so a slot the player named themselves is
  // never overwritten. Flushed now: it is once per character and the tile shows it immediately.
  nameCharacter(account: Account, charId: string, name: string): void {
    const char = account.characters?.find((c) => c.id === charId);
    if (!char || char.name === name || !PLACEHOLDER_NAMES.has(char.name.toLowerCase())) return;
    char.name = name;
    this.dirty.add(account.name.toLowerCase());
    void this.flush();
  }

  touchCharacter(account: Account, charId: string): void {
    const char = account.characters?.find((c) => c.id === charId);
    if (!char) return;
    char.lastPlayedAt = new Date().toISOString();
    this.dirty.add(account.name.toLowerCase());
  }

  // Onboarding. Sets/changes the unique public handle. The index write is awaited (a
  // uniqueness race must lose loudly, not eventually); the account itself rides the dirty
  // queue like every other mutation.
  async setUsername(
    account: Account,
    username: string,
  ): Promise<'ok' | 'badformat' | 'reserved-word' | 'taken' | 'cooldown'> {
    const valid = validUsername(username);
    if (valid !== 'ok') return valid;
    const accountKey = account.name.toLowerCase();
    const usernameLower = username.toLowerCase();
    const oldLower = account.username?.toLowerCase();
    if (oldLower === usernameLower) {
      // Case-only change of one's own handle: no uniqueness or cooldown question.
      account.username = username;
      this.dirty.add(accountKey);
      return 'ok';
    }
    if (account.username !== undefined && account.usernameChangedAt !== undefined) {
      const since = Date.now() - Date.parse(account.usernameChangedAt);
      if (since < USERNAME_RENAME_COOLDOWN_MS) return 'cooldown';
    }
    // Uniqueness is the table's PRIMARY KEY now, not "a file exists at this path".
    const row = this.db
      .prepare('SELECT accountKey, reservedUntil FROM usernames WHERE username = ?')
      .get(usernameLower) as { accountKey: string; reservedUntil: string | null } | undefined;
    const existing = row
      ? { accountKey: row.accountKey, reservedUntil: row.reservedUntil ?? undefined }
      : undefined;
    if (existing && existing.accountKey !== accountKey) {
      const reserved = existing.reservedUntil !== undefined && Date.parse(existing.reservedUntil) > Date.now();
      if (reserved || existing.reservedUntil === undefined) return 'taken';
      // Reservation expired: the handle is free again.
    }
    // The claim and the old handle's reservation are ONE transaction: a crash between them
    // would either free a handle nobody can reclaim or leave two rows pointing at this
    // account with no reservation window.
    const reservedUntil =
      oldLower !== undefined ? new Date(Date.now() + USERNAME_RESERVE_MS).toISOString() : undefined;
    tx(this.db, () => {
      const put = this.db.prepare(
        'INSERT OR REPLACE INTO usernames (username, accountKey, reservedUntil) VALUES (?, ?, ?)',
      );
      put.run(usernameLower, accountKey, null);
      // Keep the old handle pointing at us as a time-boxed reservation: nobody can take it
      // and impersonate the player their friends still know by that name.
      if (oldLower !== undefined) put.run(oldLower, accountKey, reservedUntil ?? null);
    });
    account.username = username;
    account.usernameChangedAt = new Date().toISOString();
    this.dirty.add(accountKey);
    return 'ok';
  }

  setEmail(account: Account, email: string, marketingOptIn?: boolean): void {
    account.email = email;
    if (marketingOptIn !== undefined) account.marketingOptIn = marketingOptIn;
    this.dirty.add(account.name.toLowerCase());
  }

  // M8: rank/ban mutations go through the dirty queue like lastSeen. The account must be
  // in cache (every caller has just awaited get()).
  setRank(name: string, rank: number): void {
    const account = this.cache.get(name.toLowerCase());
    if (!account) return;
    account.rank = rank;
    this.dirty.add(name.toLowerCase());
  }

  setBanned(name: string, banned: boolean): void {
    const account = this.cache.get(name.toLowerCase());
    if (!account) return;
    if (banned) account.banned = true;
    else delete account.banned;
    this.dirty.add(name.toLowerCase());
  }

  // Erasure (--delete-account): forget the cached copy so nothing rewrites the file we
  // are about to unlink.
  forget(name: string): void {
    const key = name.toLowerCase();
    this.cache.delete(key);
    this.dirty.delete(key);
  }

  touchLastSeen(name: string): void {
    const key = name.toLowerCase();
    const account = this.cache.get(key);
    if (!account) return;
    account.lastSeenAt = new Date().toISOString();
    this.dirty.add(key);
  }

  async flush(): Promise<void> {
    const keys = [...this.dirty];
    this.dirty.clear();
    for (const key of keys) {
      const account = this.cache.get(key);
      if (!account) continue;
      try {
        this.writeNow(key, account);
      } catch (err) {
        this.dirty.add(key); // retry on the next flush
        log('error', 'accounts.flush_failed', { account: key, error: String(err) });
      }
    }
  }

  async close(): Promise<void> {
    clearInterval(this.flushTimer);
    await this.flush();
  }
}
