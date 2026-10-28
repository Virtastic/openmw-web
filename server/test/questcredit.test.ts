// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// ONE WORLD, OWN CAMPAIGNS (OT3-31). There is no world owner: every player's deeds advance
// their OWN journal and globals, and nobody is ever shown a borrowed campaign.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Quests } from '../src/core/quests';
import { PlayerStore } from '../src/persist/playerstore';
import { CellStore } from '../src/persist/cellstore';
import type { Player, Roster } from '../src/core/players';
import { tmpDataDir } from './helpers';

type Sent = { name: string; body: Record<string, unknown> };

function harness(opts: { worldGlobals?: string[]; party?: string[] } = {}) {
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
    regressAllowed: () => false,
    ...(opts.party ? { partyMembers: (a: string) => (opts.party!.includes(a) ? opts.party! : [a]) } : {}),
    ...(opts.worldGlobals ? { worldGlobals: opts.worldGlobals } : {}),
  });

  return {
    quests, players, add,
    events: (acct: string, name: string) => (sent.get(acct) ?? []).filter((e) => e.name === name),
    journalOf: (acct: string) => players.getCached(acct)?.journal ?? {},
    setJournal: (acct: string, questId: string, idx: number) =>
      players.update(acct, (d) => { (d.journal ??= {})[questId] = idx; }),
    close: async () => { await players.close(); await cells.close(); },
  };
}

const entry = (questId: string, index: number) =>
  new Map<string, unknown>([['questId', questId], ['index', index]]) as never;

test("a player's deed advances their own log, and nobody else's", async () => {
  const w = harness();
  w.add('alice');
  const bob = w.add('bob');
  w.setJournal('alice', 'MQ', 10);
  w.quests.handleEvent(bob, 'JournalEntry', entry('MQ', 20));
  assert.equal(w.journalOf('bob').MQ, 20, "bob's own campaign advanced");
  assert.equal(w.journalOf('alice').MQ, 10, "alice's campaign is untouched by bob's deed");
  assert.equal(w.events('alice', 'JournalEntry').length, 0, 'nor is it relayed to her (OT3-51)');
  await w.close();
});

// Backlog 335: a relog replays the whole journalLog through the engine. A regress to a stage
// the log already holds is a replay: no doc write, no relay.
test('replaying a 3-stage log after a relog writes nothing and relays nothing', async () => {
  const w = harness();
  const alice = w.add('alice');
  w.add('bob');
  for (const i of [10, 20, 30]) w.quests.handleEvent(alice, 'JournalEntry', entry('MQ', i));
  assert.equal(w.journalOf('alice').MQ, 30);
  const before = JSON.stringify(w.players.getCached('alice'));
  const relayed = w.events('bob', 'JournalEntry').length;
  w.quests.sendJournalSync(alice); // the relog's sync opens the replay window (1.7.1)
  for (const i of [10, 20]) w.quests.handleEvent(alice, 'JournalEntry', entry('MQ', i));
  assert.equal(JSON.stringify(w.players.getCached('alice')), before, 'zero JournalEntry writes');
  assert.equal(w.journalOf('alice').MQ, 30, 'the campaign did not rewind');
  assert.equal(w.events('bob', 'JournalEntry').length, relayed, 'others do not see the index bounce');
  await w.close();
});

test('a lagging client cannot rewind its own campaign', async () => {
  const w = harness();
  const bob = w.add('bob');
  w.quests.handleEvent(bob, 'JournalEntry', entry('MQ', 40));
  w.quests.handleEvent(bob, 'JournalEntry', entry('MQ', 20)); // stale client
  assert.equal(w.journalOf('bob').MQ, 40);
  await w.close();
});

const gvar = (name: string, value: number) =>
  new Map<string, unknown>([['name', name], ['value', value]]) as never;

test("a player's quest GLOBALS land on their own character", async () => {
  const w = harness();
  w.add('alice');
  const bob = w.add('bob');
  w.quests.handleEvent(bob, 'GlobalVarUpdate', gvar('FreedSlavesCounter', 7));
  assert.equal(w.players.getCached('bob')?.globals?.FreedSlavesCounter, 7);
  assert.equal(w.players.getCached('alice')?.globals?.FreedSlavesCounter, undefined);
  await w.close();
});

test('JournalSync shows each player their own log and never a borrowed one', async () => {
  const w = harness();
  const alice = w.add('alice');
  const bob = w.add('bob');
  w.setJournal('alice', 'MQ', 30);
  w.setJournal('bob', 'SIDE', 5);
  w.quests.sendJournalSync(alice);
  w.quests.sendJournalSync(bob);
  const shown = w.events('bob', 'JournalSync')[0]?.body;
  assert.equal(shown?.borrowed, false);
  assert.equal((shown?.quests as Record<string, number>).MQ, undefined, "bob is not shown alice's campaign");
  assert.equal(w.events('alice', 'JournalSync')[0]?.body.borrowed, false);
  await w.close();
});

// OT3-90: party credit. Co-present, active, already-on-the-quest, behind: those members advance.
test('party credit reaches co-present active members on the quest, and only forward (OT3-90)', async () => {
  const w = harness({ party: ['lead', 'near', 'afk', 'far', 'fresh', 'ahead'] });
  const now = Date.now();
  const lead = w.add('lead', '0,0');
  const near = w.add('near', '1,0');
  const afk = w.add('afk', '0,0');
  const far = w.add('far', '5,5');
  const fresh = w.add('fresh', '0,0');
  const ahead = w.add('ahead', '0,0');
  for (const p of [near, far, fresh, ahead]) (p as { lastInputAt?: number }).lastInputAt = now;
  (afk as { lastInputAt?: number }).lastInputAt = now - 10 * 60_000;
  for (const a of ['lead', 'near', 'afk', 'far']) w.setJournal(a, 'MQ', 10);
  w.setJournal('ahead', 'MQ', 40);
  w.quests.handleEvent(lead, 'JournalEntry', entry('MQ', 20));
  assert.equal(w.journalOf('lead').MQ, 20);
  assert.equal(w.journalOf('near').MQ, 20, 'co-present (visible cell) member credited');
  assert.equal(w.events('near', 'JournalEntry').length, 1, 'and their client hears it');
  assert.equal(w.journalOf('afk').MQ, 10, 'AFK member not credited');
  assert.equal(w.journalOf('far').MQ, 10, 'far member not credited');
  assert.equal(w.journalOf('fresh').MQ, undefined, 'never started the quest: not eligible');
  assert.equal(w.journalOf('ahead').MQ, 40, 'a member past the stage keeps theirs');
  // near's client echoes the relayed entry: a no-op, and no ping-pong back to lead.
  w.quests.handleEvent(near, 'JournalEntry', entry('MQ', 20));
  assert.equal(w.events('lead', 'JournalEntry').length, 0);
  await w.close();
});
