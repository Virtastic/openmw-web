// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// THE SHARED SOCIAL DATABASE IS OPENED BY EVERY WORLD PROCESS AT ONCE.
//
// SocialStore used to open its own DatabaseSync instead of going through openDb, which made it
// the only store in the repo without `PRAGMA busy_timeout` — while being the ONE database
// genuinely shared across processes. WAL admits a single writer, so N worlds writing presence
// on a 10s heartbeat contend; with no timeout that is an instant SQLITE_BUSY throw rather than
// a short wait, and it surfaced inside setInterval, where an uncaughtException takes the whole
// world process (and everyone in it) down.
//
// persist/sqlite.ts documents the same class of bug being caught by a two-process test. This is
// that test for this store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialStore } from '../src/core/socialstore';

test('two processes writing presence to one file do not throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omw-social-cc-'));
  // Two handles on one file is what two world processes are, minus the process boundary — and
  // the lock is held by SQLite at the file level, so it contends identically.
  const a = new SocialStore(dir);
  const b = new SocialStore(dir);
  try {
    for (let i = 0; i < 200; i++) {
      a.setPresence(`acct-a-${i}`, 'vvardenfell', `A${i}`, 'cell', false, Date.now());
      b.setPresence(`acct-b-${i}`, 'priv-b', `B${i}`, 'cell', false, Date.now());
    }
    // Both processes' writes must actually be there — a lost write is the quieter half of this
    // bug and would not show up as a throw.
    const online = b.presentEverywhere(Date.now(), 60_000);
    assert.equal(online.filter((r) => r.account.startsWith('acct-a-')).length, 200);
    assert.equal(online.filter((r) => r.account.startsWith('acct-b-')).length, 200);
  } finally {
    a.close();
    b.close();
  }
});

// The class comment says "every mutation routes through here, so the closed check exists once".
// Five did not: appendChat (twice), setPresence, clearPresence, addRequest and addInvite — which
// are exactly the heartbeat and teardown paths that run DURING shutdown. Post-close they threw
// `database is not open` from a promise nobody awaits.
test('writes after close are dropped, not thrown', () => {
  const s = new SocialStore(':memory:');
  s.close();
  const now = Date.now();
  assert.doesNotThrow(() => s.setPresence('a', 'w', 'A', 'cell', false, now));
  assert.doesNotThrow(() => s.clearPresence('a', 'w', now));
  assert.doesNotThrow(() => s.appendChat(
    { ts: now, channel: 'global', scope: '', acct: 'a', name: 'A', text: 'hi' }, 200));
  assert.doesNotThrow(() => s.addRequest('a', 'b', now, 60_000));
  assert.doesNotThrow(() => s.addInvite('a', 'b', 'party', now, 60_000));
});
