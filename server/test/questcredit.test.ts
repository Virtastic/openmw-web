// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 4 quest model: the party-credit eligibility matrix (behind/on-stage/ahead ×
// present/absent × in-party/stranger) and character-shadowed mwscript globals.
//
// This is the fix for TES3MP's most-named failure — a shared journal that advances
// everyone when anyone talks to an NPC — so the invariants are asserted directly:
// nobody's journal moves through content they did not play.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Quests } from '../src/core/quests';
import { PlayerStore } from '../src/persist/playerstore';
import { CellStore } from '../src/persist/cellstore';
import type { Player, Roster } from '../src/core/players';
import { tmpDataDir } from './helpers';

type Sent = { name: string; body: Record<string, unknown> };

function harness(opts: { party?: string[]; partyCredit?: boolean; worldGlobals?: string[] } = {}) {
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

  const roster = { inWorld: () => list } as unknown as Roster;
  const quests = new Quests({
    roster,
    cells,
    players,
    isShared: (f) => f === "questVars", // journals per-character; world globals may relay
    regressAllowed: () => false,
    partyOf: (acct) => (opts.party ?? []).includes(acct) ? (opts.party ?? []) : [],
    ...(opts.partyCredit !== undefined ? { partyCredit: opts.partyCredit } : {}),
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

const entry = (questId: string, index: number) => new Map<string, unknown>([['questId', questId], ['index', index]]) as never;

test('party credit: only co-present, already-started, behind members advance', async () => {
  const w = harness({ party: ['alice', 'bob', 'carol', 'dave'] });
  const alice = w.add('alice', '0,0');
  w.add('bob', '0,0');    // co-present, started, behind  -> CREDITED
  w.add('carol', '9,9');  // in party, started, behind, ELSEWHERE -> not credited
  w.add('dave', '0,0');   // co-present, NEVER STARTED -> not credited (no spoiler jump)
  const eve = w.add('eve', '0,0'); // co-present, started, behind, NOT IN PARTY -> not credited
  void eve;

  w.setJournal('bob', 'MQ', 10);
  w.setJournal('carol', 'MQ', 10);
  w.setJournal('eve', 'MQ', 10);
  // dave: no entry at all

  w.quests.handleEvent(alice, 'JournalEntry', entry('MQ', 20));

  assert.equal(w.journalOf('bob').MQ, 20, 'a co-present party member who started it advances');
  assert.equal(w.events('bob', 'JournalEntry')[0]?.body.credited, true);
  assert.equal(w.journalOf('carol').MQ, 10, 'a party member in another cell gets nothing');
  assert.equal(w.journalOf('dave').MQ, undefined, 'a member who never started the quest is NOT jumped forward');
  assert.equal(w.journalOf('eve').MQ, 10, 'a stranger standing there gets nothing');
  await w.close();
});

test('party credit never rewinds someone who is ahead, and never fires when disabled', async () => {
  const w = harness({ party: ['alice', 'bob'] });
  const alice = w.add('alice');
  w.add('bob');
  w.setJournal('bob', 'MQ', 50); // ahead of alice
  w.quests.handleEvent(alice, 'JournalEntry', entry('MQ', 20));
  assert.equal(w.journalOf('bob').MQ, 50, 'a member ahead of the deed is never rewound');
  await w.close();

  const off = harness({ party: ['alice', 'bob'], partyCredit: false });
  const a2 = off.add('alice');
  off.add('bob');
  off.setJournal('bob', 'MQ', 10);
  off.quests.handleEvent(a2, 'JournalEntry', entry('MQ', 20));
  assert.equal(off.journalOf('bob').MQ, 10, 'partyCredit=false disables the rule entirely');
  await off.close();
});

test('solo play is unaffected: no party, no credit, own journal still recorded', async () => {
  const w = harness();
  const alice = w.add('alice');
  w.add('bob');
  w.setJournal('bob', 'MQ', 10);
  w.quests.handleEvent(alice, 'JournalEntry', entry('MQ', 20));
  assert.equal(w.journalOf('alice').MQ, 20, 'the reporter always records their own entry');
  assert.equal(w.journalOf('bob').MQ, 10, 'a non-party bystander is untouched');
  await w.close();
});

const globalUpdate = (name: string, value: number) =>
  new Map<string, unknown>([['name', name], ['value', value]]) as never;

test('quest globals are character-shadowed by default; world globals still relay', async () => {
  const w = harness({ party: [], worldGlobals: ['MyModWorldFlag'] });
  const alice = w.add('alice');
  w.add('bob');

  // A quest-progress global: stored on the character, relayed to NOBODY (this is what
  // stops two members at different stages overwriting each other forever).
  w.quests.handleEvent(alice, 'GlobalVarUpdate', globalUpdate('MSCorprusCured', 1));
  assert.equal(w.players.getCached('alice')?.globals?.MSCorprusCured, 1);
  assert.equal(w.events('bob', 'GlobalVarUpdate').length, 0, 'progress globals must not travel');

  // A world global (built-in set) DOES relay.
  w.quests.handleEvent(alice, 'GlobalVarUpdate', globalUpdate('BlightDisease', 1));
  assert.equal(w.events('bob', 'GlobalVarUpdate').length, 1, 'world globals still relay');

  // ...as does an operator-declared one.
  w.quests.handleEvent(alice, 'GlobalVarUpdate', globalUpdate('MyModWorldFlag', 3));
  assert.equal(w.events('bob', 'GlobalVarUpdate').length, 2, 'configured world globals relay');
  await w.close();
});

test('character globals are restored at join', async () => {
  const w = harness();
  const alice = w.add('alice');
  w.quests.handleEvent(alice, 'GlobalVarUpdate', globalUpdate('MSCorprusCured', 1));
  w.quests.sendGlobalSync(alice);
  const sync = w.events('alice', 'GlobalVarSync')[0];
  assert.ok(sync, 'a character with shadowed globals gets them back');
  assert.deepEqual(sync.body.globals, { MSCorprusCured: 1 });
  await w.close();
});
