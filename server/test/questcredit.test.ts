// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// INSTANCE-OWNED QUEST LOGS. One log per instance and it belongs to the owner: guests see
// the owner's campaign while visiting, advance it with their deeds, and keep NOTHING of
// their own. In your own Solo world you ARE the owner, so it is the same rule, not a case.
//
// This file used to test Phase 4 "party credit", which advanced co-present members' OWN
// journals. That is deleted — under instance ownership a guest's doc is frozen for the whole
// visit, so two systems advancing journals would only disagree. The assertions below are the
// replacement contract, not a thinner version of the old one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Quests } from '../src/core/quests';
import { PlayerStore } from '../src/persist/playerstore';
import { CellStore } from '../src/persist/cellstore';
import type { Player, Roster } from '../src/core/players';
import { tmpDataDir } from './helpers';

type Sent = { name: string; body: Record<string, unknown> };

// `owner` is the account whose campaign this instance is. undefined = unowned (the shared
// world), which persists nothing.
function harness(opts: { owner?: string; shareJournal?: boolean; worldGlobals?: string[] } = {}) {
  const dir = tmpDataDir();
  const players = new PlayerStore(dir, 'w1');
  const cells = new CellStore(dir);
  const list: Player[] = [];
  const sent = new Map<string, Sent[]>();

  const add = (acct: string, cellKey = '0,0'): Player => {
    const box: Sent[] = [];
    sent.set(acct, box);
    const p = {
      id: list.length + 1,
      name: acct,
      accountKey: acct,
      charId: acct,
      rank: 0,
      inWorld: true,
      cellKey,
      peer: { sendEvent: (n: string, b: Record<string, unknown>) => void box.push({ name: n, body: b }) },
    } as unknown as Player;
    list.push(p);
    return p;
  };

  const roster = {
    inWorld: () => list,
    activeForAccount: (a: string) => list.find((p) => p.accountKey === a),
  } as unknown as Roster;
  const quests = new Quests({
    roster,
    cells,
    players,
    isShared: (f) => (f === 'journal' ? opts.shareJournal !== false : f === 'questVars'),
    regressAllowed: () => false,
    // Owned instance -> the owner's doc; unowned -> nothing (the shared-lobby case).
    journalTarget: () => opts.owner,
    ownerCharId: () => opts.owner,
    ...(opts.worldGlobals ? { worldGlobals: opts.worldGlobals } : {}),
  });

  return {
    quests, players, add,
    events: (acct: string, name: string) => (sent.get(acct) ?? []).filter((e) => e.name === name),
    journalOf: (acct: string) => players.getCached(acct)?.journal ?? {},
    sharedJournal: () => cells.sharedQuest().journal,
    setJournal: (acct: string, questId: string, idx: number) =>
      players.update(acct, (d) => { (d.journal ??= {})[questId] = idx; }),
    close: async () => { await players.close(); await cells.close(); },
  };
}

const entry = (questId: string, index: number) =>
  new Map<string, unknown>([['questId', questId], ['index', index]]) as never;

test("a guest's deed advances the OWNER's log and never their own", async () => {
  const w = harness({ owner: 'alice' });
  w.add('alice');
  const bob = w.add('bob'); // a guest in alice's world
  w.setJournal('bob', 'MQ', 10); // bob's own campaign, mid-quest

  w.quests.handleEvent(bob, 'JournalEntry', entry('MQ', 20));

  assert.equal(w.journalOf('alice').MQ, 20, "the owner's campaign advanced");
  assert.equal(w.sharedJournal().MQ, 20, 'the instance log advanced');
  assert.equal(w.journalOf('bob').MQ, 10,
    "the guest's OWN journal moved — a visit must never touch their campaign");
  await w.close();
});

test('the owner advancing their own world writes their own log (solo is the same rule)', async () => {
  const w = harness({ owner: 'alice' });
  const alice = w.add('alice');
  w.quests.handleEvent(alice, 'JournalEntry', entry('MQ', 20));
  assert.equal(w.journalOf('alice').MQ, 20, 'in your own world you are the owner');
  assert.equal(w.sharedJournal().MQ, 20);
  await w.close();
});

test('an unowned instance (the shared world) persists to no character at all', async () => {
  const w = harness({ owner: undefined });
  const bob = w.add('bob');
  w.setJournal('bob', 'MQ', 10);
  w.quests.handleEvent(bob, 'JournalEntry', entry('MQ', 20));
  assert.equal(w.journalOf('bob').MQ, 10, 'the shared world must not write to a character');
  assert.equal(w.sharedJournal().MQ, 20, 'but the live instance log still moves');
  await w.close();
});

test('a guest is SHOWN the owner\'s log on join, without adopting it into their save', async () => {
  const w = harness({ owner: 'alice' });
  const alice = w.add('alice');
  w.setJournal('alice', 'MQ', 30);
  w.quests.sendJournalSync(alice); // owner arrives first: seeds the instance from their campaign
  assert.equal(w.sharedJournal().MQ, 30, "a fresh instance seeds from the owner's campaign");

  const bob = w.add('bob');
  w.setJournal('bob', 'SIDE', 5);
  w.quests.sendJournalSync(bob);
  const shown = w.events('bob', 'JournalSync')[0]?.body.quests as Record<string, number>;
  assert.equal(shown.MQ, 30, 'the guest is shown the campaign they are visiting');
  assert.deepEqual(w.journalOf('bob'), { SIDE: 5 },
    "the guest's own save is untouched by being shown someone else's log");
  await w.close();
});

test('a lagging guest cannot rewind the owner\'s campaign', async () => {
  const w = harness({ owner: 'alice' });
  w.add('alice');
  const bob = w.add('bob');
  w.quests.handleEvent(bob, 'JournalEntry', entry('MQ', 40));
  w.quests.handleEvent(bob, 'JournalEntry', entry('MQ', 20)); // stale client
  assert.equal(w.sharedJournal().MQ, 40, 'monotonic-max still guards the instance log');
  assert.equal(w.journalOf('alice').MQ, 40);
  await w.close();
});

// Morrowind gates most quests on GLOBALS, not the journal index. Shadowing globals to the
// guest while the journal went to the owner advanced a guest's gates without their log —
// they went home with globals saying "done" and a journal saying stage 10, which can leave a
// quest ungiveable in their own campaign. Both halves freeze together or neither does.
const gvar = (name: string, value: number) =>
  new Map<string, unknown>([['name', name], ['value', value]]) as never;

test('a guest\'s quest GLOBALS follow the journal, not their own character', async () => {
  const w = harness({ owner: 'alice' });
  w.add('alice');
  const bob = w.add('bob');

  w.quests.handleEvent(bob, 'GlobalVarUpdate', gvar('FreedSlavesCounter', 7));

  assert.equal(w.players.getCached('alice')?.globals?.FreedSlavesCounter, 7,
    "the owner's campaign records the gate the guest moved");
  assert.equal(w.players.getCached('bob')?.globals?.FreedSlavesCounter, undefined,
    "the guest's own gates moved — their journal is frozen but their quest state was not");
  await w.close();
});

test('in your own world the gate is yours, and the shared world stores none', async () => {
  const mine = harness({ owner: 'alice' });
  const alice = mine.add('alice');
  mine.quests.handleEvent(alice, 'GlobalVarUpdate', gvar('FreedSlavesCounter', 3));
  assert.equal(mine.players.getCached('alice')?.globals?.FreedSlavesCounter, 3);
  await mine.close();

  const lobby = harness({ owner: undefined });
  const bob = lobby.add('bob');
  lobby.quests.handleEvent(bob, 'GlobalVarUpdate', gvar('FreedSlavesCounter', 9));
  assert.equal(lobby.players.getCached('bob')?.globals?.FreedSlavesCounter, undefined,
    'the shared world must not write quest state to any character');
  await lobby.close();
});

// The client cannot tell whose instance it is in, so the sync must say. Driven off the sync
// rather than a "leaving" event because sendJournalSync runs on EVERY join (connection.ts
// handleReady) — a missed transition then repairs itself on the next one instead of leaving
// a guest holding someone else's campaign.
test('JournalSync tells the client whether the campaign is borrowed', async () => {
  const w = harness({ owner: 'alice' });
  const alice = w.add('alice');
  const bob = w.add('bob');

  w.quests.sendJournalSync(alice);
  assert.equal(w.events('alice', 'JournalSync')[0]?.body.borrowed, false,
    'the owner is never borrowing their own campaign');

  w.quests.sendJournalSync(bob);
  assert.equal(w.events('bob', 'JournalSync')[0]?.body.borrowed, true,
    'a guest must be told to set their own journal aside');
  await w.close();

  // An unowned instance (the shared world) is not a campaign at all.
  const lobby = harness({ owner: undefined });
  const carol = lobby.add('carol');
  lobby.quests.sendJournalSync(carol);
  assert.equal(lobby.events('carol', 'JournalSync')[0]?.body.borrowed, false,
    'the shared world must not make anyone stash their journal');
  await lobby.close();
});
