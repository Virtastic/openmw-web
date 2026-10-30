// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-99: the faction titles behind nameplates.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Titles, topFaction } from '../src/core/titles';
import type { Player, Roster } from '../src/core/players';

test('topFaction: highest rank wins, expelled and non-members are ignored, ties are stable', () => {
  assert.equal(topFaction(undefined), undefined);
  assert.deepEqual(topFaction({ a: { rank: 3 }, b: { rank: 7 }, c: { rank: 9, expelled: true }, d: { rank: 0 } }), { faction: 'b', rank: 7 });
  assert.deepEqual(topFaction({ z: { rank: 4 }, m: { rank: 4 } }), { faction: 'm', rank: 4 });
});

test('Titles.tick: everyone gets the set once, again only when it changes; a joiner is caught up', () => {
  const sent = new Map<number, unknown[]>();
  const mk = (id: number): Player => ({ id, name: `p${id}`, inWorld: true, peer: {
    sendEvent: (n: string, b: unknown) => { if (n === 'PlayerTitles') (sent.get(id) ?? sent.set(id, []).get(id)!).push(b); } } } as unknown as Player);
  const list = [mk(1), mk(2)];
  const docs: Record<number, Record<string, { rank: number }>> = { 1: { fighters_guild: { rank: 5 } }, 2: {} };
  const roster = { inWorld: () => list } as unknown as Roster;
  const t = new Titles({ roster, factionsOf: (p) => docs[p.id] });
  t.tick(); t.tick();
  assert.equal(sent.get(1)!.length, 1, 'unchanged set is not re-sent');
  assert.deepEqual((sent.get(2)![0] as { titles: unknown }).titles, [{ id: 1, faction: 'fighters_guild', rank: 5 }]);
  docs[2] = { mages_guild: { rank: 2 } };
  t.tick();
  assert.equal(sent.get(1)!.length, 2);
  list.push(mk(3)); docs[3] = {};
  t.tick();
  assert.equal(sent.get(3)!.length, 1, 'the joiner gets the current set');
  assert.equal(sent.get(1)!.length, 2, 'the others are not re-sent');
});
