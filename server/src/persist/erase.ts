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
import { join } from 'node:path';

// A4: the chat log is a per-line stream, so erasure REWRITES each day file without this
// account's lines rather than deleting the file — one player's deletion request must not
// destroy everyone else's conversation. Whole-file delete only happens if nothing is left.
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

export interface EraseReport {
  account: boolean;
  player: boolean;
  bans: boolean;
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

export async function deleteAccount(dataDir: string, name: string): Promise<EraseReport> {
  const key = name.toLowerCase();
  const report: EraseReport = {
    account: await unlinkIfPresent(join(dataDir, 'accounts', `${key}.json`)),
    player: await unlinkIfPresent(join(dataDir, 'players', `${key}.json`)),
    bans: false,
    chatLines: await eraseChatLines(dataDir, key),
    reports: await eraseReports(dataDir, key),
  };
  // An account ban keeps the name (and an ip ban an address); erasure lifts it. That is
  // the honest trade and it is documented: a ban cannot outlive the data it names.
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
