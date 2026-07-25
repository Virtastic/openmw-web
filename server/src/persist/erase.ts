// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M8 erasure (PRIVACY.md): remove everything this server stores about one account —
// the credential file (name, argon2id hash, timestamps, rank), the character document
// and any ban entry naming it. Runs OFFLINE against the data directory (`--delete-account
// <name>`) so it cannot race a live session's write-behind flush.
//
// What it deliberately does NOT touch, because the data is not keyed to the account:
//   * world/cell docs — a chest the player opened is world state, not personal data; the
//     only personal field is the transient `byId` playerId on spawned objects, which is a
//     per-session number, not an identifier.
//   * stdout logs — they are the operator's to rotate (see PRIVACY.md); this tool prints
//     what to grep for instead of pretending it can rewrite an operator's log pipeline.

import { rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface EraseReport {
  account: boolean;
  player: boolean;
  bans: boolean;
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
