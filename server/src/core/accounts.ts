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
  // Ids of characters this account has DELETED. The gateway and every world write this whole
  // document, so a write has to merge the character list rather than replace it (see
  // writeNow) — and a plain union would resurrect deleted slots forever. Bounded: the tail is
  // dropped, because a tombstone only has to outlive other processes' stale caches.
  deletedCharacters?: string[];
  // Onboarding profile. email is CONTACT data: it must never appear in any wire payload
  // or peer-visible surface — only the owner's own profile view and the CRM hook see it.
  // username is the unique public handle shown everywhere in-game (nametags, chat,
  // friends, admin views); account `name` remains the login identifier only.
  email?: string;
  username?: string;
  marketingOptIn?: boolean;
  usernameChangedAt?: string; // rename rate-limit anchor
  // Web dashboard access, deliberately SEPARATE from `rank`. "May run /console in-game" and
  // "may edit [economy] in a browser" are different questions that usually travel together
  // and occasionally must not: a trusted in-world admin is not automatically someone who
  // should be able to rewrite the server's storage backend from a phone. Absent = no
  // dashboard access at all, which is the default for every account that ever registers.
  dashboardRole?: DashboardRole;
  // TOTP shared secret (base32) for the PASSWORD login path. Absent = not enrolled.
  totpSecret?: string;
}

// Ordered least -> most privileged; `roleAtLeast` relies on the index.
export const DASHBOARD_ROLES = ['viewer', 'moderator', 'owner'] as const;
export type DashboardRole = (typeof DASHBOARD_ROLES)[number];

/** Does `have` meet or exceed `need`? Absent role = no access to anything gated. */
export function roleAtLeast(have: DashboardRole | undefined, need: DashboardRole): boolean {
  if (!have) return false;
  return DASHBOARD_ROLES.indexOf(have) >= DASHBOARD_ROLES.indexOf(need);
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

// A hash of a throwaway string, used to spend the same time on a failed lookup as on a real
// one. A CONSTANT rather than something computed at startup: verifying costs the same either
// way (the work is set by the parameters encoded in the string), while computing it lazily
// meant a promise that, if it ever rejected, stayed rejected for the life of the process and
// turned every subsequent failed login into a 500. Publishing it gives nothing away — it is
// the hash of a value nobody uses, and knowing a hash does not help you produce a password.
const DECOY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$RU6yeWfVvzoWBMQhyahFpg$K4iaLtJpJx++1tpgeJ4ot/gUn8Fueld+CkWt63pKBvQ';
// A login identifier is either a plain name or an email address. Plain names were the only
// option and the cap was 24, which rejected an email outright — and since the dashboard's
// setup wizard now asks for one, that rejection was the first thing a new operator hit.
//
// `name` is the LOGIN identifier only. What other players see is `username` (see the Account
// doc comment and server.ts's displayName), so putting an email here does not put it in
// chat, nametags or the friends list.
const NAME_RE = /^[A-Za-z0-9_ -]{2,32}$/;

// Deliberately narrower than RFC 5322: no quoted local parts, and the local charset is only
// letters, digits and . _ % + -. That is every address a real mailbox actually uses, and it
// contains no "/", no "\" and no space — which matters, because the lowercased name becomes
// a storage key that is concatenated into blob paths (locker.ts: `gamedata/${key}/...`).
// Consecutive dots are refused separately, so ".." can never appear either.
// Distinct from EMAIL_RE above, which validates the PROFILE email and is deliberately loose
// (it only has to catch typos). This one gates a value that becomes an account key, so it is
// strict on purpose.
const LOGIN_EMAIL_RE =
  /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function looksLikeEmail(name: string): boolean {
  return name.length <= 254 && !name.includes('..')
    && !name.startsWith('.') && !name.includes('.@') && LOGIN_EMAIL_RE.test(name);
}

export function validAccountName(name: string): boolean {
  return NAME_RE.test(name) || looksLikeEmail(name);
}

/**
 * Why a name was refused, in the words of what the person actually typed.
 *
 * "must be 2-24 characters: letters, numbers, spaces, _ or -" states the rule and leaves
 * you to diff it against your own input, which is how someone types an email address, reads
 * "letters, numbers", and concludes the server is broken. Name the offending character.
 */
export function accountNameProblem(name: string): string | null {
  if (validAccountName(name)) return null;
  const trimmed = name.trim();
  if (trimmed === '') return 'is required.';
  if (name !== trimmed) return 'has a space at the start or end. Remove it and try again.';
  if (name.includes('@')) {
    // They meant an email; say what is wrong with THIS email rather than offering the
    // plain-name rule, which is not the rule they were trying to follow.
    if (name.includes('..')) return 'has two dots in a row, which no mail provider allows.';
    if (!/@[^@]+\.[^@]+$/.test(name)) return 'looks like an email but has no domain after the @ (for example name@example.com).';
    if ((name.match(/@/g) ?? []).length > 1) return 'has more than one @.';
    return 'is not a valid email address. Check it for stray characters.';
  }
  if (trimmed.length < 2) return 'is too short: at least 2 characters.';
  if (trimmed.length > 32) return `is too long: ${trimmed.length} characters, and the limit is 32.`;
  const bad = [...trimmed].find((c) => !/[A-Za-z0-9_ -]/.test(c));
  if (bad !== undefined) {
    return `cannot contain "${bad}". Use an email address, or letters, numbers, spaces, _ and - only.`;
  }
  return 'is not usable. Try an email address instead.';
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
    // MERGE THE SLOT LIST, never replace it. The gateway and every world process hold their
    // own AccountStore over this one file and each writes the WHOLE document, so the last
    // flush won outright: a process whose cached copy predated a character wiped that
    // character off the account. Observed live — three player docs with real journals and an
    // account with ZERO slots, which is a finished character that has to run chargen again
    // because the character screen cannot see it. Read-through on get() fixed stale READS;
    // this is the same disease on the write side.
    //
    // Union by id, newest lastPlayedAt wins, minus this account's deletion tombstones — a
    // plain union would resurrect every deleted character the moment a stale process flushed.
    const row = this.db.prepare('SELECT doc FROM accounts WHERE key = ?').get(key) as
      { doc: string } | undefined;
    const merged: Account = { ...account };
    if (row) {
      try {
        const disk = JSON.parse(row.doc) as Account;
        const tombs = new Set([...(account.deletedCharacters ?? []), ...(disk.deletedCharacters ?? [])]);
        const byId = new Map<string, CharacterSummary>();
        for (const c of disk.characters ?? []) byId.set(c.id, c);
        for (const c of account.characters ?? []) {
          const prev = byId.get(c.id);
          // A slot we know about wins unless disk's copy was played more recently.
          if (!prev || (prev.lastPlayedAt ?? '') <= (c.lastPlayedAt ?? '')) byId.set(c.id, c);
        }
        for (const id of tombs) byId.delete(id);
        merged.characters = [...byId.values()];
        if (tombs.size > 0) merged.deletedCharacters = [...tombs].slice(0, 64);
      } catch { /* unreadable row: our copy is the best we have */ }
    }
    this.db.prepare('INSERT OR REPLACE INTO accounts (key, doc) VALUES (?, ?)')
      .run(key, JSON.stringify(merged));
    // Keep the in-memory copy consistent with what is now on disk, or the next mutation
    // would rebuild the same stale list and undo the merge we just did.
    account.characters = merged.characters;
    if (merged.deletedCharacters) account.deletedCharacters = merged.deletedCharacters;
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

  // Username -> account key. Players type the PUBLIC HANDLE (it is what every social surface
  // shows), so anything resolving a typed name has to accept it. Case-insensitive, straight
  // off the uniqueness table that already owns the mapping.
  keyForUsername(username: string): string | undefined {
    const row = this.db
      .prepare('SELECT accountKey FROM usernames WHERE username = ?')
      .get(username.toLowerCase()) as { accountKey: string } | undefined;
    return row?.accountKey;
  }

  /** Read-modify-WRITE-THROUGH under one synchronous critical section.
   *
   *  THE CHARACTER-LOSS BUG. flush() writes `this.cache.get(key)` — the CACHED object — while
   *  get() replaced that cached object on every read-through miss. ChargenComplete issues two
   *  concurrent get()s on the same account, so the second one swapped the cache to a fresh
   *  object B while the caller still held A; adoptCharacter then pushed the character onto A
   *  and flush() wrote B. The player finished creation, the log said character.created, and
   *  the account kept zero slots — five finished characters were orphaned this way on the dev
   *  server, their PlayerDocs intact and nothing pointing at them.
   *
   *  Object identity was load-bearing and invisible. It is not any more: mutations re-read by
   *  KEY, apply, and write immediately (node:sqlite is synchronous, so this whole body runs
   *  without interleaving). A caller's stale Account reference is simply ignored. */
  private mutate<T>(account: Account, fn: (doc: Account) => T | undefined): T | undefined {
    const key = account.name.toLowerCase();
    // Fold what is on disk INTO the caller's object rather than building a rival copy, so
    // every holder of this account converges on one identity instead of diverging. Callers
    // read their own reference back immediately (Welcome lists account.characters), so a
    // mutation applied to a private copy is invisible to them — and a mutation applied to
    // THEIR copy while flush wrote a different one is how characters got lost.
    const row = this.db.prepare('SELECT doc FROM accounts WHERE key = ?').get(key) as
      { doc: string } | undefined;
    if (row) {
      try { Object.assign(account, JSON.parse(row.doc) as Account); } catch { /* keep ours */ }
    }
    const out = fn(account);
    if (out === undefined) return undefined; // the mutation declined; nothing to write
    this.writeNow(key, account); // keeps the cross-process character merge + tombstones
    this.cache.set(key, account); // this object is now THE cached one
    this.dirty.delete(key); // written through: no queued copy may overwrite it later
    return out;
  }

  async get(name: string): Promise<Account | undefined> {
    const key = name.toLowerCase();
    const cached = this.cache.get(key);
    // Pending writes win — a doc with queued mutations is the truth this process is about to
    // flush, and replacing it would lose them. A CLEAN cached doc is only a first impression:
    // the gateway and every world share accounts.db, and each used to serve whatever was true
    // the first time it looked, forever. A long-running world then authenticated players
    // against a character list from another era — stale slots, stale completed flags — which
    // put one into a DELETED character's still-running world with inChargen wrongly false,
    // where the sim peer took the cell and froze the chargen guard. Third instance of the
    // same never-re-read disease (PlayerStore had it twice); read through unless dirty.
    if (cached && this.dirty.has(key)) return cached;
    const row = this.db.prepare('SELECT doc FROM accounts WHERE key = ?').get(key) as
      { doc: string } | undefined;
    const loaded = row ? (JSON.parse(row.doc) as Account) : undefined;
    if (loaded) this.cache.set(key, loaded);
    // Row gone but cached: deletion raced us; the delete path owns cache eviction.
    return loaded ?? cached;
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
    // BURN THE SAME TIME ON A MISS. argon2id at these parameters takes tens of milliseconds,
    // so returning early for "no such account" or "SSO-only account with no password" made
    // the response time itself an account oracle — far outside network jitter, and the
    // identical error body did nothing to hide it. Verifying against a fixed throwaway hash
    // costs the same work and reveals nothing. Both the dashboard and the game login come
    // through here, so this covers both.
    if (!account?.pwHash) {
      await verify(DECOY_HASH, password).catch(() => false);
      return null;
    }
    return (await verify(account.pwHash, password)) ? account : null;
  }

  // Character slots. Mutations go through the dirty queue; callers hold a cached account
  // (every auth path has just awaited get()).
  //
  // createCharacter is also the pre-slot migration step: an account with no characters[]
  // gets its first slot named after the account, and the caller adopts any legacy
  // account-keyed PlayerDoc under the new character id.
  /** An id for a character that does not exist yet. The slot is only written once creation
   *  FINISHES (adoptCharacter), so a player who quits during Morrowind's opening leaves
   *  nothing behind — no tile, no row, no doc. Nothing to hide and nothing to delete, which
   *  matters because the one signal that says "creation finished" is client-reported and can
   *  go missing: an earlier revision deleted real characters by treating its absence as proof
   *  of abandonment (see the regression test in characters.test.ts). */
  provisionalCharacterId(): string {
    return `c${randomBytes(12).toString('hex')}`;
  }

  /** Write a provisional character into the account, now that creation has finished. Same cap
   *  as createCharacter — the check has to happen HERE, since nothing was reserved up front. */
  adoptCharacter(account: Account, charId: string, name: string): CharacterSummary | 'full' | 'exists' {
    return this.mutate(account, (doc) => {
      const chars = (doc.characters ??= []);
      if (chars.some((c) => c.id === charId)) return 'exists' as const;
      if (chars.length >= MAX_CHARACTERS) return 'full' as const;
      const now = new Date().toISOString();
      const char: CharacterSummary = { id: charId, name, createdAt: now, lastPlayedAt: now, completed: true };
      chars.push(char);
      return char;
    }) ?? 'full';
  }

  createCharacter(account: Account, name: string): CharacterSummary | 'full' {
    return this.mutate(account, (doc) => {
      const chars = (doc.characters ??= []);
      if (chars.length >= MAX_CHARACTERS) return 'full' as const;
      return this.buildCharacter(chars, name);
    }) ?? 'full';
  }

  private buildCharacter(chars: CharacterSummary[], name: string): CharacterSummary {
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
    return char;
  }

  // Marks creation finished for a slot. Written through IMMEDIATELY rather than riding the
  // 30 s dirty sweep: finish creation, refresh inside that window, and the flag never reached
  // disk — the slot then looked like an unfinished creation on the next login. It fires once
  // per character, so the cost is nothing.
  completeCharacter(account: Account, charId: string): void {
    this.mutate(account, (doc) => {
      const char = doc.characters?.find((c) => c.id === charId);
      if (!char || char.completed) return undefined;
      char.completed = true;
      return true as const;
    });
  }

  // Delete a character slot. The slot record goes; the character's PlayerDoc is erased by the
  // caller (it owns the PlayerStore). Returns false when the id does not belong to this
  // account — never trust a client-supplied id to name someone else's character.
  deleteCharacter(account: Account, charId: string): boolean {
    // No precheck against the caller's copy: mutate() re-reads the doc by key, so a check out
    // here can only disagree with the one inside. The closure below is the whole decision.
    return this.mutate(account, (doc) => {
      const list = doc.characters;
      if (!list) return undefined;
      const at = list.findIndex((c) => c.id === charId);
      if (at < 0) return undefined;
      list.splice(at, 1);
      const tomb = doc.deletedCharacters ?? [];
      if (!tomb.includes(charId)) tomb.unshift(charId);
      doc.deletedCharacters = tomb.slice(0, 64);
      return true as const;
    }) === true;
  }

  // Chargen is where a character is really named; the name reaches the server in the
  // appearance. Only ever replaces the PLACEHOLDER, so a slot the player named themselves is
  // never overwritten. Flushed now: it is once per character and the tile shows it immediately.
  nameCharacter(account: Account, charId: string, name: string): void {
    // Never accept a placeholder AS the name: the client used to send the session name, which
    // before chargen is the slot label, so "New character" was written in as though the player
    // had chosen it — and then this guard refused every later correction, because the slot no
    // longer looked like a placeholder. Reject the placeholder on the way in as well as out.
    if (PLACEHOLDER_NAMES.has(name.trim().toLowerCase())) return;
    this.mutate(account, (doc) => {
      const c = doc.characters?.find((x) => x.id === charId);
      if (!c || c.name === name || !PLACEHOLDER_NAMES.has(c.name.toLowerCase())) return undefined;
      c.name = name;
      return true as const;
    });
  }

  touchCharacter(account: Account, charId: string): void {
    this.mutate(account, (doc) => {
      const char = doc.characters?.find((c) => c.id === charId);
      if (!char) return undefined;
      char.lastPlayedAt = new Date().toISOString();
      return true as const;
    });
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
      this.mutate(account, (doc) => { doc.username = username; return 'ok'; });
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
    // WRITE-THROUGH, not the dirty queue. flush() writes this.cache.get(key) while get()
    // swaps the cached object on every clean read-through — the same shape that lost
    // characters. Here it was worse than a lost field: the usernames row above is already
    // committed, so a dropped write left the handle CLAIMED and reserved for 30 days while the
    // account doc had no username. The player reads as un-onboarded and nobody, including
    // them, can ever claim that handle.
    this.mutate(account, (doc) => {
      doc.username = username;
      doc.usernameChangedAt = new Date().toISOString();
      return 'ok';
    });
    return 'ok';
  }

  setEmail(account: Account, email: string, marketingOptIn?: boolean): void {
    // Write-through: this takes a CALLER-HELD Account, so the dirty queue could write a
    // different object than the one just mutated. See setUsername.
    this.mutate(account, (doc) => {
      doc.email = email;
      if (marketingOptIn !== undefined) doc.marketingOptIn = marketingOptIn;
      return 'ok';
    });
  }

  // M8: rank/ban. Written through rather than queued — a ban that a later flush drops is a
  // banned player still playing. The account must be in cache (every caller has just awaited
  // get()).
  setRank(name: string, rank: number): void {
    const account = this.cache.get(name.toLowerCase());
    if (!account) return;
    this.mutate(account, (doc) => { doc.rank = rank; return 'ok'; });
  }

  // --- Web dashboard access -------------------------------------------------------------
  // These take the name and load through get(), unlike setRank/setBanned which only touch
  // the cache: the dashboard acts on accounts that are not online and so were never cached.

  async setDashboardRole(name: string, role: DashboardRole | undefined): Promise<boolean> {
    const account = await this.get(name);
    if (!account) return false;
    this.cache.set(name.toLowerCase(), account); // mutate() writes through the cached object
    this.mutate(account, (doc) => {
      if (role) doc.dashboardRole = role;
      else delete doc.dashboardRole;
      return 'ok';
    });
    return true;
  }

  /** Set (or replace) the password. Used by the lockout-recovery CLI path. */
  async setPassword(name: string, password: string): Promise<boolean> {
    const account = await this.get(name);
    if (!account) return false;
    const pwHash = await hash(password, ARGON2_OPTS);
    this.cache.set(name.toLowerCase(), account);
    this.mutate(account, (doc) => { doc.pwHash = pwHash; return 'ok'; });
    return true;
  }

  async setTotpSecret(name: string, secret: string | undefined): Promise<boolean> {
    const account = await this.get(name);
    if (!account) return false;
    this.cache.set(name.toLowerCase(), account);
    this.mutate(account, (doc) => {
      if (secret) doc.totpSecret = secret;
      else delete doc.totpSecret;
      return 'ok';
    });
    return true;
  }

  /**
   * Every account on disk. Small by construction — a self-hosted world's account table is
   * hundreds of rows, not millions — so the dashboard's browser and the first-run check can
   * both afford a full scan rather than carrying an index that has to be kept true.
   */
  listAll(): Account[] {
    const rows = this.db.prepare('SELECT key, doc FROM accounts').all() as
      { key: string; doc: string }[];
    const out: Account[] = [];
    for (const r of rows) {
      // Pending writes win, exactly as get() does: a dirty cached doc is what this process is
      // about to flush, so listing the disk copy would show a value we already superseded.
      const cached = this.cache.get(r.key);
      if (cached && this.dirty.has(r.key)) { out.push(cached); continue; }
      try { out.push(JSON.parse(r.doc) as Account); } catch { /* unreadable row: skip */ }
    }
    return out;
  }

  /**
   * Does anyone hold dashboard `owner` yet? This is the first-run test: false means the
   * onboarding wizard runs, true means it does not. Deliberately NOT "is rank 3" — an
   * in-world owner seeded by [admin].owners has not necessarily ever opened the dashboard,
   * and treating them as one would skip setup on a server nobody has actually configured.
   */
  hasDashboardOwner(): boolean {
    return this.listAll().some((a) => a.dashboardRole === 'owner');
  }

  setBanned(name: string, banned: boolean): void {
    const account = this.cache.get(name.toLowerCase());
    if (!account) return;
    this.mutate(account, (doc) => {
      if (banned) doc.banned = true;
      else delete doc.banned;
      return 'ok';
    });
  }

  // Erasure (--delete-account): forget the cached copy so nothing rewrites the file we
  // are about to unlink.
  forget(name: string): void {
    const key = name.toLowerCase();
    this.cache.delete(key);
    this.dirty.delete(key);
    // keysOnDisk too, or existsNow keeps answering true for an account whose row is about to
    // be unlinked — which made a deleted account still resolve for friend-request name lookup
    // until the next restart.
    this.keysOnDisk.delete(key);
  }

  // The one mutation that stays on the dirty queue on purpose: it fires on every join and
  // carries nothing anyone would miss, so batching it is right. It is also the only writer
  // left, which is what makes mutate()'s dirty.delete() harmless — there is no longer a queued
  // copy holding a field that a write-through would silently roll back.
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
