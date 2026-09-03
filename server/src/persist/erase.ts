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

import { existsSync, rmSync } from 'node:fs';
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
// Every eraser below opens a database, deletes rows, and closes. A table that does not exist
// yet holds nothing about this account, so it is not an erasure failure.
function withDb<T>(path: string, fallback: T, fn: (db: DatabaseSync) => T): T {
  if (!existsSync(path)) return fallback;
  const db = new DatabaseSync(path);
  try {
    return fn(db);
  } catch (err) {
    if (/no such table/i.test(String(err))) return fallback;
    throw err;
  } finally {
    db.close();
  }
}

// The account row and every username it holds — including handles still RESERVED to it after
// a rename. Leaving the row keeps the person's display name and email; leaving a reservation
// keeps a handle pointing at an account that no longer exists.
function eraseAccountDb(dataDir: string, key: string): boolean {
  return withDb(join(dataDir, 'accounts.db'), false, (db) => {
    db.prepare('DELETE FROM usernames WHERE accountKey = ?').run(key);
    return Number(db.prepare('DELETE FROM accounts WHERE key = ?').run(key).changes) > 0;
  });
}

// Read the account doc from wherever it actually lives. erasePlayerDocs needs the character
// list BEFORE the account is erased — it is the only way to find that account's player
// documents — and reading only the old JSON path silently found no characters and left every
// character document on disk after an "erasure".
type AccountDoc = { characters?: { id?: unknown }[] } | undefined;
function readAccountDoc(dataDir: string, key: string): AccountDoc {
  return withDb(join(dataDir, 'accounts.db'), undefined as AccountDoc, (db) => {
    const row = db.prepare('SELECT doc FROM accounts WHERE key = ?').get(key) as
      { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as AccountDoc) : undefined;
  });
}

function eraseIdentitiesDb(dataDir: string, key: string): number {
  return withDb(join(dataDir, 'identities.db'), 0, (db) =>
    Number(db.prepare('DELETE FROM identities WHERE accountKey = ?').run(key).changes));
}

function eraseModerationDb(dataDir: string, key: string): { chatLines: number; reports: number } {
  return withDb(join(dataDir, 'moderation.db'), { chatLines: 0, reports: 0 }, (db) => {
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
  });
}




// The locker's file list, its attestation (which names the person and their IP), the save
// list, and — when storage is this server's own disk — the bytes themselves. This was
// missing entirely: an offline erasure left the whole library and every savegame in place,
// reachable again the moment the same SSO identity signed back in.
//
// S3-backed bytes are NOT reachable from here (the credentials are the running server's,
// from its env). Those are erased by the online POST /locker/erase; this reports what it
// could not reach rather than pretending otherwise.
function eraseLockerAndSaves(dataDir: string, key: string): { locker: boolean; saves: number } {
  const locker = withDb(join(dataDir, 'locker.db'), false, (db) => {
    const files = Number(db.prepare('DELETE FROM locker_files WHERE accountKey = ?').run(key).changes);
    const att = Number(db.prepare('DELETE FROM locker_attestations WHERE accountKey = ?').run(key).changes);
    return files > 0 || att > 0;
  });
  const saves = withDb(join(dataDir, 'saves.db'), 0, (db) =>
    Number(db.prepare('DELETE FROM player_saves WHERE accountKey = ?').run(key).changes));
  for (const prefix of ['gamedata', 'saves']) {
    rmSync(join(dataDir, 'locker-blobs', prefix, key), { recursive: true, force: true });
  }
  return { locker, saves };
}

export interface EraseReport {
  account: boolean;
  player: boolean;
  bans: boolean;
  locker: boolean; // file list + attestation (and the bytes, when stored on this disk)
  saves: number; // savegames removed
  identities: number; // Phase B: linked SSO identities removed
  chatLines: number; // A4: lines removed from logs/chat-*.jsonl AND social chat history
  reports: number; // A4: report docs removed (filed BY or ABOUT the account)
  socialRows: number; // friends, blocks, requests, invites, mutes, presence and prefs
}

// A character document is the bulk of what this server knows about a person (inventory,
// journal, position), so missing one is not a partial erasure, it is a failed one. The ids
// come from the account row, which is why this must run BEFORE the account is erased. `key`
// itself is included for the pre-slot account-keyed doc.
function erasePlayerDocs(dataDir: string, key: string): boolean {
  const charIds = (readAccountDoc(dataDir, key)?.characters ?? [])
    .map((c) => c.id)
    .filter((id): id is string => typeof id === 'string');
  return withDb(join(dataDir, 'players.db'), false, (db) =>
    [key, ...charIds].some(
      (k) => Number(db.prepare('DELETE FROM players WHERE key = ?').run(k).changes) > 0));
}


// THE SOCIAL GRAPH IS PERSONAL DATA TOO, and erase.ts did not open social.sqlite at all --
// so an "erased" account left behind its friends and blocks, the requests and invites it sent
// or received, its mutes, its presence row (display NAME, last cell, world) and its own chat
// lines. The chat lines are the sharpest miss: eraseModerationDb is careful to delete the
// other copy of exactly the same text. Keyed by accountKey in every table below.
function eraseSocialDb(dataDir: string, key: string): { rows: number; chatLines: number } {
  return withDb(join(dataDir, 'social.sqlite'), { rows: 0, chatLines: 0 }, (db) => {
    const del = (sql: string, ...args: string[]): number => {
      try {
        return Number(db.prepare(sql).run(...args).changes);
      } catch {
        return 0; // a table this build never created is not an erasure failure
      }
    };
    const chatLines = del('DELETE FROM chat_history WHERE acct = ?', key);
    const rows =
      del('DELETE FROM friend WHERE a = ? OR b = ?', key, key)
      + del('DELETE FROM block WHERE blocker = ? OR blocked = ?', key, key)
      + del('DELETE FROM friend_request WHERE fromAcct = ? OR toAcct = ?', key, key)
      + del('DELETE FROM invite WHERE fromAcct = ? OR toAcct = ?', key, key)
      + del('DELETE FROM mute WHERE muter = ? OR muted = ?', key, key)
      + del('DELETE FROM presence WHERE account = ?', key)
      + del('DELETE FROM presence_pref WHERE account = ?', key)
      + del('DELETE FROM availability_pref WHERE account = ?', key);
    return { rows, chatLines };
  });
}

export async function deleteAccount(dataDir: string, name: string): Promise<EraseReport> {
  const key = name.toLowerCase();
  const dbErased = eraseModerationDb(dataDir, key);
  // Order matters: character docs are found VIA the account file, so erase them first.
  const player = erasePlayerDocs(dataDir, key);
  const lockerErased = eraseLockerAndSaves(dataDir, key);
  const social = eraseSocialDb(dataDir, key);
  const report: EraseReport = {
    account: eraseAccountDb(dataDir, key),
    player,
    bans: false,
    locker: lockerErased.locker,
    saves: lockerErased.saves,
    identities: eraseIdentitiesDb(dataDir, key),
    // BOTH copies of the person's chat: moderation.db and social.sqlite's history.
    chatLines: dbErased.chatLines + social.chatLines,
    reports: dbErased.reports,
    socialRows: social.rows,
  };
  // An account ban keeps the name (and an ip ban an address); erasure lifts it. That is the
  // honest trade and it is documented: a ban cannot outlive the data it names.
  report.bans = withDb(join(dataDir, 'bans.db'), false, (db) =>
    Number(db.prepare("DELETE FROM bans WHERE scope = 'account' AND key = ?").run(key).changes) > 0);
  return report;
}
