// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 4 party rules: difficulty scaling keyed on CO-PRESENT members, gold split, and
// roll-on-rare. The invariants worth protecting are the ones both reference co-op games
// got wrong — Valheim under-scales so groups trivialize content, V Rising multiplies boss
// minions per player so groups are punished for being a group.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PartyRules, DEFAULT_SCALING } from '../src/core/party-rules';
import type { Player, Roster } from '../src/core/players';

type Sent = { name: string; body: Record<string, unknown> };

function harness(opts: { party?: string[]; goldSplit?: boolean; rollOnRare?: boolean; enabled?: boolean; scaling?: boolean } = {}) {
  const list: Player[] = [];
  const sent = new Map<string, Sent[]>();
  const add = (acct: string, cellKey = '0,0'): Player => {
    const box: Sent[] = [];
    sent.set(acct, box);
    const p = {
      id: list.length + 1, name: acct, accountKey: acct, charId: acct, rank: 0,
      inWorld: true, cellKey,
      peer: { sendEvent: (n: string, b: Record<string, unknown>) => void box.push({ name: n, body: b }) },
    } as unknown as Player;
    list.push(p);
    return p;
  };
  const rules = new PartyRules({
    roster: { inWorld: () => list } as unknown as Roster,
    partyOf: (acct) => ((opts.party ?? []).includes(acct) ? (opts.party ?? []) : []),
    // scaling defaults TRUE here so the existing scaling cases keep testing the maths rather
    // than the new opt-in gate; the gate has its own cases below.
    settingsOf: () => ({
      goldSplit: opts.goldSplit ?? true,
      rollOnRare: opts.rollOnRare ?? false,
      scaling: opts.scaling ?? true,
    }),
    isNotable: (id) => id === 'sunder',
    enabled: opts.enabled ?? true,
  });
  return { rules, add, events: (a: string, n: string) => (sent.get(a) ?? []).filter((e) => e.name === n) };
}

test('scaling counts only party members standing with you', () => {
  const w = harness({ party: ['a', 'b', 'c', 'd'] });
  const a = w.add('a', '0,0');
  w.add('b', '0,0');   // co-present
  w.add('c', '0,0');   // co-present
  w.add('d', '40,40'); // in the party, elsewhere — must not buff this fight
  w.add('stranger', '0,0'); // not in the party

  const s = w.rules.scalingFor(a)!;
  assert.equal(s.members, 3, 'three co-present members');
  assert.ok(Math.abs(s.hp - (1 + DEFAULT_SCALING.hpPerExtra * 2)) < 1e-9);
  assert.ok(Math.abs(s.damage - (1 + DEFAULT_SCALING.damagePerExtra * 2)) < 1e-9);
  assert.ok(s.hp < 3, 'sub-linear: three players must not mean triple HP (that is tedium, not difficulty)');
  assert.equal(s.extraSpawns, 1, 'one extra creature per two extra members');
});

test('a solo player is never scaled, and extra spawns stay capped', () => {
  const solo = harness();
  assert.equal(solo.rules.scalingFor(solo.add('a')), null, 'solo play is untouched');

  const big = harness({ party: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] });
  const a = big.add('a');
  for (const n of ['b', 'c', 'd', 'e', 'f', 'g', 'h']) big.add(n);
  const s = big.rules.scalingFor(a)!;
  assert.equal(s.extraSpawns, DEFAULT_SCALING.maxExtraSpawns,
    'spawn augmentation is capped — punishing a group for being a group is the V Rising failure');
});

test('disabled scaling is inert', () => {
  const w = harness({ party: ['a', 'b'], enabled: false });
  const a = w.add('a');
  w.add('b');
  assert.equal(w.rules.scalingFor(a), null);
});

test('gold splits among co-present members with the remainder to the looter', () => {
  const w = harness({ party: ['a', 'b', 'c'] });
  const a = w.add('a', '0,0');
  w.add('b', '0,0');
  w.add('c', '9,9'); // elsewhere: no cut of what they were not there for

  const split = w.rules.splitGold(a, 101)!;
  assert.equal(split.length, 2);
  assert.deepEqual(split.find((s) => s.acct === 'b'), { acct: 'b', share: 50 });
  assert.deepEqual(split.find((s) => s.acct === 'a'), { acct: 'a', share: 51 }, 'remainder to the looter');
  assert.equal(split.reduce((t, s) => t + s.share, 0), 101, 'no gold is created or destroyed');

  assert.equal(w.rules.splitGold(a, 1), null, 'a split that would round to nothing is not worth doing');
  const off = harness({ party: ['a', 'b'], goldSplit: false });
  const a2 = off.add('a');
  off.add('b');
  assert.equal(off.rules.splitGold(a2, 100), null, 'the leader can turn it off');
});

test('roll-on-rare: only notable items, only when enabled, only with company', () => {
  const off = harness({ party: ['a', 'b'] }); // rollOnRare defaults false
  const a0 = off.add('a');
  off.add('b');
  assert.equal(off.rules.shouldRoll(a0, 'sunder'), false, 'default is not to interrupt');

  const w = harness({ party: ['a', 'b'], rollOnRare: true });
  const a = w.add('a');
  w.add('b');
  assert.equal(w.rules.shouldRoll(a, 'iron_dagger'), false, 'ordinary loot is never rolled');
  assert.equal(w.rules.shouldRoll(a, 'sunder'), true);

  const alone = harness({ party: ['a'], rollOnRare: true });
  assert.equal(alone.rules.shouldRoll(alone.add('a'), 'sunder'), false, 'nobody to roll against');
});

test('a roll asks everyone, settles on need, and treats silence as a pass', () => {
  const w = harness({ party: ['a', 'b', 'c'], rollOnRare: true });
  const a = w.add('a');
  w.add('b');
  w.add('c');

  const { rollId } = w.rules.startRoll(a, 'sunder');
  assert.equal(w.events('b', 'LootRoll').length, 1, 'every co-present member is asked');
  assert.equal(w.events('c', 'LootRoll').length, 1);

  assert.deepEqual(w.rules.vote(rollId, 'a', 'pass'), { done: false });
  assert.deepEqual(w.rules.vote(rollId, 'b', 'pass'), { done: false });
  const done = w.rules.vote(rollId, 'c', 'need') as { done: true; winner?: string; itemId: string };
  assert.equal(done.done, true);
  assert.equal(done.winner, 'c', 'the only need wins');
  assert.equal(done.itemId, 'sunder');
});

test('a roll nobody answers expires instead of pinning the item forever', () => {
  const w = harness({ party: ['a', 'b'], rollOnRare: true });
  const a = w.add('a');
  w.add('b');
  const { rollId } = w.rules.startRoll(a, 'sunder', 1000);
  assert.deepEqual(w.rules.sweep(1000), [], 'still open inside the window');
  const swept = w.rules.sweep(1000 + 30_000);
  assert.equal(swept.length, 1);
  assert.equal(swept[0]!.rollId, rollId);
  assert.equal(swept[0]!.winner, undefined, 'all passes means nobody wins, not a deadlock');
});

// SCALING IS THE LEADER'S CHOICE, and it has to be a choice they can actually make.
//
// [rules] partyScaling ships OFF: people come to co-op to play Morrowind together, not to have
// it quietly made harder because a friend walked in. That is only defensible if a group that
// WANTS the challenge can turn it on — and for a while it was not, because the config default
// was flipped off while party settings still only knew about loot, leaving scaling
// operator-only with no way back. This pins both halves.
test('scaling off for this party means no scaling, however many are present', () => {
  const { rules, add } = harness({ party: ['a', 'b', 'c'], scaling: false });
  add('a'); add('b'); add('c');
  assert.equal(rules.scalingFor(add('a2')), null, 'a party that opted out was scaled anyway');
});

test('...and a party that opts IN is scaled', () => {
  const { rules, add } = harness({ party: ['a', 'b'], scaling: true });
  const a = add('a'); add('b');
  const s = rules.scalingFor(a);
  assert.ok(s, 'a party that asked for scaling did not get it');
  assert.ok(s.hp > 1 && s.damage > 1);
});

// The operator's kill switch still outranks the party: enabled=false is "not on this world".
test('the operator switch still wins over a party that wants scaling', () => {
  const { rules, add } = harness({ party: ['a', 'b'], scaling: true, enabled: false });
  const a = add('a'); add('b');
  assert.equal(rules.scalingFor(a), null);
});
