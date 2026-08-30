// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Proof that whoever is claiming the first admin account can read this server's own files.
//
// WHY THIS EXISTS, because the first version did not have it and was badly wrong.
//
// Setup used to be gated on "does any account hold the dashboard owner role". That reads as
// a first-run check and is not one: `dashboardRole` is a NEW field, so on every server that
// upgrades to this build the answer is no, forever. The route that creates the first owner
// therefore stayed open on an internet-facing box, and /admin/api/state advertised it. Worse,
// naming an account that already existed skipped registration entirely and promoted it —
// full owner, including remote script execution on players' machines, without knowing any
// password.
//
// Account state cannot answer "is this a fresh install", so it no longer tries. Instead the
// server mints a token when no owner exists, writes it beside its other secrets and prints it
// at boot. Claiming the first account requires presenting it, which requires read access to
// the machine — the same proof of ownership `--admin-reset` relies on. The setup scripts read
// the file and put it in the URL they open, so for anyone following the documented path this
// is invisible.

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { log } from '../../log';

const FILE = 'setup-token';

/** The banner is announced at most once per process; see arm(). */
let announced = false;

export class SetupToken {
  private token = '';

  constructor(private readonly dataDir: string) {}

  /** Mint (or re-read) the token and announce it. Call only when no owner exists yet. */
  arm(): void {
    const path = join(this.dataDir, FILE);
    try {
      if (existsSync(path)) {
        this.token = readFileSync(path, 'utf8').trim();
      }
      if (this.token === '') {
        mkdirSync(this.dataDir, { recursive: true });
        this.token = randomBytes(24).toString('base64url');
        // 0600 where the platform honours it. A bind mount on Windows will not, which is
        // why this is a proof-of-read-access token with a short life and not a credential
        // we rely on long-term.
        writeFileSync(path, this.token, { mode: 0o600 });
      }
    } catch (err) {
      // If it cannot be persisted, keep the in-memory one: a restart invalidates it, which
      // is inconvenient but never insecure.
      if (this.token === '') this.token = randomBytes(24).toString('base64url');
      log('warn', 'admin.setup_token_unwritable', { error: String(err) });
    }

    // Printed as its own block because this is the one thing an operator has to find in the
    // log, and a single structured line scrolls past.
    //
    // Once per process: a real deployment runs one server per process (the gateway spawns
    // each world as its own), so nothing is lost — but the test suite builds dozens of
    // servers in one process and would otherwise bury its own output in banners.
    if (announced) return;
    announced = true;
    process.stdout.write(
      `\n${'='.repeat(72)}\n`
      + '  FIRST-TIME SETUP\n\n'
      + '  Nobody administers this server yet. Open /admin in a browser and it will\n'
      + '  walk you through it. From this machine or this network, that is all.\n\n'
      + '  Setting it up from somewhere else -- over the internet, say -- needs this key,\n'
      + '  so that a stranger who finds the page cannot claim the server first:\n\n'
      + `      ${this.token}\n\n`
      + `  Also saved to ${join(this.dataDir, FILE)}. It stops working the moment the\n`
      + '  first administrator account exists.\n'
      + `${'='.repeat(72)}\n\n`,
    );
  }

  /** True when setup is still open AND the caller presented the right key. */
  verify(presented: string): boolean {
    if (this.token === '' || presented === '') return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Setup is finished: the token stops working and the file goes away. */
  disarm(): void {
    this.token = '';
    try {
      const path = join(this.dataDir, FILE);
      if (existsSync(path)) unlinkSync(path);
    } catch { /* best effort; verify() already refuses everything */ }
  }

  get armed(): boolean {
    return this.token !== '';
  }
}
