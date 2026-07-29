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

async function eraseChatLines(dataDir: string, key: string): Promise<number> {
  const dir = join(dataDir, 'logs');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  let removed = 0;
  for (const name of names.filter((n) => /^chat-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))) {
    const path = join(dir, name);
    const kept: string[] = [];
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      if (line.length === 0) continue;
      let account: unknown;
      try {
        account = (JSON.parse(line) as { account?: unknown }).account;
      } catch {
        kept.push(line); // unparseable: keep it, it names nobody we can match
        continue;
      }
      if (account === key) removed++;
      else kept.push(line);
    }
    if (kept.length === 0) await rm(path, { force: true });
    else await writeFile(path, kept.join('\n') + '\n', 'utf8');
  }
  return removed;
}

// Reports FILED BY the account carry their name; reports ABOUT it carry their name too, and
// the attached context lines quote them. Both go: a half-erased report is not an erasure.
async function eraseReports(dataDir: string, key: string): Promise<number> {
  const dir = join(dataDir, 'reports');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  let removed = 0;
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const path = join(dir, name);
    let doc: { reporter?: { account?: unknown }; target?: { account?: unknown; name?: unknown } };
    try {
      doc = JSON.parse(await readFile(path, 'utf8')) as typeof doc;
    } catch {
      continue; // unreadable: leave it for the operator rather than deleting blind
    }
    const namesAccount =
      doc.reporter?.account === key ||
      doc.target?.account === key ||
      (typeof doc.target?.name === 'string' && doc.target.name.toLowerCase() === key);
    if (namesAccount) {
      await rm(path, { force: true });
      removed++;
    }
  }
  return removed;
}

// Phase B: an (iss,sub) pair identifies a person AT A PROVIDER, so it is personal data and
// goes with the account. Leaving it behind would also mean the next SSO login silently
// re-created the erased account.
async function eraseIdentities(dataDir: string, key: string): Promise<number> {
  const dir = join(dataDir, 'identities');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  let removed = 0;
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const path = join(dir, name);
    let doc: { accountKey?: unknown };
    try {
      doc = JSON.parse(await readFile(path, 'utf8')) as typeof doc;
    } catch {
      continue; // unreadable: leave it for the operator rather than deleting blind
    }
    if (doc.accountKey === key) {
      await rm(path, { force: true });
      removed++;
    }
  }
  return removed;
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
  let charIds: string[] = [];
  try {
    const account = JSON.parse(await readFile(join(dataDir, 'accounts', `${key}.json`), 'utf8')) as {
      characters?: { id?: unknown }[];
    };
    charIds = (account.characters ?? [])
      .map((c) => c.id)
      .filter((id): id is string => typeof id === 'string');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  let removed = await unlinkIfPresent(join(dataDir, 'players', `${key}.json`));
  for (const id of charIds) {
    if (await unlinkIfPresent(join(dataDir, 'players', `${id}.json`))) removed = true;
  }
  return removed;
}

// Onboarding: the username index and any not-yet-sent CRM upserts name the account (the
// queue even carries the email). Both are personal data; both go. Records already
// delivered to the CRM are the operator's to purge per the takedown/deletion runbook.
async function eraseByAccountField(dir: string, key: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  let removed = 0;
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const path = join(dir, name);
    try {
      const doc = JSON.parse(await readFile(path, 'utf8')) as { accountKey?: unknown };
      if (doc.accountKey === key) {
        await rm(path, { force: true });
        removed++;
      }
    } catch {
      continue; // unreadable: leave it for the operator rather than deleting blind
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
    account: await unlinkIfPresent(join(dataDir, 'accounts', `${key}.json`)),
    player,
    bans: false,
    identities: eraseIdentitiesDb(dataDir, key) + (await eraseIdentities(dataDir, key)),
    // Both layouts are summed: the DB rows plus anything still in the legacy files.
    chatLines: dbErased.chatLines + (await eraseChatLines(dataDir, key)),
    reports: dbErased.reports + (await eraseReports(dataDir, key)),
  };
  await eraseByAccountField(join(dataDir, 'usernames'), key);
  await eraseByAccountField(join(dataDir, 'integrations', 'attio-queue'), key);
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
  const bansPath = join(dataDir, 'bans.json');
  try {
    const doc = JSON.parse(await readFile(bansPath, 'utf8')) as {
      accounts?: Record<string, unknown>;
      ips?: Record<string, unknown>;
    };
    if (doc.accounts && Object.hasOwn(doc.accounts, key)) {
      delete doc.accounts[key];
      await writeFile(bansPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
      report.bans = true;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return report;
}
