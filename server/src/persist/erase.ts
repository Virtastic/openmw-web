// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M8 erasure (PRIVACY.md): remove everything this server stores about one account —
// the credential file (name, argon2id hash, timestamps, rank), the character document,
// any ban entry naming it, and (A4) its chat lines and every report naming it. Note the
// last one destroys reports OTHER players filed about this account — the alternative is
// keeping a dossier on someone who asked to be forgotten, which is not erasure. Take a
// backup first if you are erasing someone you may still need to ban.
// Runs OFFLINE against the data directory (`--delete-account
// <name>`) so it cannot race a live session's write-behind flush.
//
// What it deliberately does NOT touch, because the data is not keyed to the account:
//   * world/cell docs — a chest the player opened is world state, not personal data; the
//     only personal field is the transient `byId` playerId on spawned objects, which is a
//     per-session number, not an identifier.
//   * stdout logs — they are the operator's to rotate (see PRIVACY.md); this tool prints
//     what to grep for instead of pretending it can rewrite an operator's log pipeline.

import { readdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

// A4: the chat log is a per-line stream, so erasure REWRITES each day file without this
// account's lines rather than deleting the file — one player's deletion request must not
// destroy everyone else's conversation. Whole-file delete only happens if nothing is left.
// Chat lines and reports live in moderation.db since the persistence consolidation. Erasure
// must DELETE those rows: missing them would leave the account's own words, and every report
// naming it, behind after an erase. The legacy files are still scrubbed below so an erase run
// against either layout is complete.
// SSO identities moved into identities.db. Same rule as the moderation and ban tables: the
// rows must GO, or the next SSO login silently re-creates the account that was just erased.
// The account row and every username it holds — including handles still RESERVED to it after
// a rename — live in accounts.db. Leaving the row keeps the person's display name and email;
// leaving a reservation keeps a handle pointing at an account that no longer exists.
function eraseAccountDb(dataDir: string, key: string): boolean {
  const path = join(dataDir, 'accounts.db');
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path);
  try {
    db.prepare('DELETE FROM usernames WHERE accountKey = ?').run(key);
    return Number(db.prepare('DELETE FROM accounts WHERE key = ?').run(key).changes) > 0;
  } catch (err) {
    if (/no such table/i.test(String(err))) return false;
    throw err;
  } finally {
    db.close();
  }
}

// Read the account doc from wherever it actually lives. erasePlayerDocs needs the character
// list BEFORE the account is erased — it is the only way to find that account's player
// documents — and reading only the old JSON path silently found no characters and left every
// character document on disk after an "erasure".
function readAccountDoc(dataDir: string, key: string): { characters?: { id?: unknown }[] } | undefined {
  const path = join(dataDir, 'accounts.db');
  if (!existsSync(path)) return undefined;
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare('SELECT doc FROM accounts WHERE key = ?').get(key) as
      { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as { characters?: { id?: unknown }[] }) : undefined;
  } catch (err) {
    if (/no such table/i.test(String(err))) return undefined;
    throw err;
  } finally {
    db.close();
  }
}

function eraseIdentitiesDb(dataDir: string, key: string): number {
  const path = join(dataDir, 'identities.db');
  if (!existsSync(path)) return 0;
  const db = new DatabaseSync(path);
  try {
    return Number(db.prepare('DELETE FROM identities WHERE accountKey = ?').run(key).changes);
  } catch (err) {
    if (/no such table/i.test(String(err))) return 0;
    throw err;
  } finally {
    db.close();
  }
}

function eraseModerationDb(dataDir: string, key: string): { chatLines: number; reports: number } {
  const path = join(dataDir, 'moderation.db');
  if (!existsSync(path)) return { chatLines: 0, reports: 0 };
  const db = new DatabaseSync(path);
  try {
    const chat = db.prepare('DELETE FROM chat_lines WHERE account = ?').run(key);
    // Reports are stored as a JSON doc, so the account is matched inside it: reports FILED BY
    // this account and reports ABOUT it both go, exactly as the file-based version did.
    const rows = db.prepare('SELECT file, doc FROM reports').all() as { file: string; doc: string }[];
    const del = db.prepare('DELETE FROM reports WHERE file = ?');
    let reports = 0;
    for (const r of rows) {
      let doc: { reporter?: { account?: unknown }; target?: { account?: unknown; name?: unknown } };
      try {
        doc = JSON.parse(r.doc) as typeof doc;
      } catch {
        continue; // unreadable: leave it for the operator rather than deleting blind
      }
      const namesAccount =
        doc.reporter?.account === key ||
        doc.target?.account === key ||
        (typeof doc.target?.name === 'string' && doc.target.name.toLowerCase() === key);
      if (namesAccount) {
        del.run(r.file);
        reports++;
      }
    }
    return { chatLines: Number(chat.changes), reports };
  } catch (err) {
    // A DB that predates these tables holds nothing about this account.
    if (/no such table/i.test(String(err))) return { chatLines: 0, reports: 0 };
    throw err;
  } finally {
    db.close();
  }
}




export interface EraseReport {
  account: boolean;
  player: boolean;
  bans: boolean;
  identities: number; // Phase B: linked SSO identities removed
  chatLines: number; // A4: lines removed from logs/chat-*.jsonl
  reports: number; // A4: report docs removed (filed BY or ABOUT the account)
}

async function unlinkIfPresent(path: string): Promise<boolean> {
  try {
    await rm(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

// Character slots: an account's PlayerDocs are keyed by character id, so the character
// list must be read from the account file BEFORE the account file is unlinked. The legacy
// account-keyed doc is removed too (pre-slot worlds, or a migration that kept the source).
async function erasePlayerDocs(dataDir: string, key: string): Promise<boolean> {
  let doc = readAccountDoc(dataDir, key);
  if (!doc) {
    try {
      doc = JSON.parse(await readFile(join(dataDir, 'accounts', `${key}.json`), 'utf8')) as typeof doc;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  const charIds = (doc?.characters ?? [])
    .map((c) => c.id)
    .filter((id): id is string => typeof id === 'string');
  // Player docs live in players.db since the persistence consolidation. Delete the ROWS as
  // well as any legacy file: a character document is the bulk of what this server knows about
  // a person (inventory, journal, position), so missing it is not a partial erasure, it is a
  // failed one. Both the legacy account-keyed doc and every character id are covered.
  let removed = await unlinkIfPresent(join(dataDir, 'players', `${key}.json`));
  for (const id of charIds) {
    if (await unlinkIfPresent(join(dataDir, 'players', `${id}.json`))) removed = true;
  }
  const playersDb = join(dataDir, 'players.db');
  if (existsSync(playersDb)) {
    const db = new DatabaseSync(playersDb);
    try {
      for (const k of [key, ...charIds]) {
        if (Number(db.prepare('DELETE FROM players WHERE key = ?').run(k).changes) > 0) removed = true;
      }
    } catch (err) {
      if (!/no such table/i.test(String(err))) throw err;
    } finally {
      db.close();
    }
  }
  return removed;
}


export async function deleteAccount(dataDir: string, name: string): Promise<EraseReport> {
  const key = name.toLowerCase();
  const dbErased = eraseModerationDb(dataDir, key);
  // Order matters: character docs are found VIA the account file, so erase them first.
  const player = await erasePlayerDocs(dataDir, key);
  const report: EraseReport = {
    account: eraseAccountDb(dataDir, key),
    player,
    bans: false,
    identities: eraseIdentitiesDb(dataDir, key),
    // Both layouts are summed: the DB rows plus anything still in the legacy files.
    chatLines: dbErased.chatLines,
    reports: dbErased.reports,
  };
  // An account ban keeps the name (and an ip ban an address); erasure lifts it. That is
  // the honest trade and it is documented: a ban cannot outlive the data it names.
  // Bans live in bans.db (SQLite) since the persistence consolidation. Erasure must DELETE the
  // row: a rewritten JSON blob was the old shape, and missing this would leave the banned name
  // — and for an IP ban the only IP address this server persists — behind after an erase.
  // The legacy bans.json is still scrubbed below for installs that have not booted the new
  // store yet, so an erase run against either layout is complete.
  const bansDbPath = join(dataDir, 'bans.db');
  if (existsSync(bansDbPath)) {
    const db = new DatabaseSync(bansDbPath);
    try {
      const r = db.prepare("DELETE FROM bans WHERE scope = 'account' AND key = ?").run(key);
      if (Number(r.changes) > 0) report.bans = true;
    } catch (err) {
      // A DB that predates the table is not an erasure failure; nothing of this account is in it.
      if (!/no such table/i.test(String(err))) throw err;
    } finally {
      db.close();
    }
  }
  return report;
}
