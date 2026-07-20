// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M4 authority state machine: unit invariants + a randomized fuzz driving enter/leave/
// disconnect across many cells and players, asserting the authority invariants after
// every step.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Authority, type AuthoritySenders, type ActorSnapshot } from '../src/core/authority';

// A mirror of what the senders observe, so tests can assert grant/info/revoke traffic.
interface Recorder {
  grants: { playerId: number; cellKey: string; epoch: number; snapshot: ActorSnapshot }[];
  infos: { playerId: number; cellKey: string; holderId: number }[];
  revokes: { playerId: number; cellKey: string; epoch: number }[];
  overrides: Map<string, ActorSnapshot>;
}

function makeAuthority(): { auth: Authority; rec: Recorder } {
  const rec: Recorder = { grants: [], infos: [], revokes: [], overrides: new Map() };
  const senders: AuthoritySenders = {
    grant: (playerId, cellKey, epoch, snapshot) => rec.grants.push({ playerId, cellKey, epoch, snapshot }),
    info: (playerId, cellKey, holderId) => rec.infos.push({ playerId, cellKey, holderId }),
    revoke: (playerId, cellKey, epoch) => rec.revokes.push({ playerId, cellKey, epoch }),
    loadOverrides: async (cellKey) => rec.overrides.get(cellKey) ?? { actors: [] },
    foldOverrides: async (cellKey, snapshot) => void rec.overrides.set(cellKey, snapshot),
  };
  return { auth: new Authority(senders), rec };
}

test('authority: claim, contested entry, info, handoff, dormancy', async () => {
  const { auth, rec } = makeAuthority();
  await auth.onEnter(1, 'a'); // claims
  assert.equal(auth.holderOf('a'), 1);
  assert.equal(auth.currentEpoch('a'), 1);
  assert.deepEqual(rec.grants.at(-1), { playerId: 1, cellKey: 'a', epoch: 1, snapshot: { actors: [] } });

  await auth.onEnter(2, 'a'); // contested -> info to 2
  assert.equal(auth.holderOf('a'), 1);
  assert.deepEqual(rec.infos.at(-1), { playerId: 2, cellKey: 'a', holderId: 1 });

  await auth.onEnter(3, 'a');
  auth.setSnapshot('a', { actors: [{ ref: 'x' }] }); // holder pushes a snapshot

  await auth.onLeave(1, 'a', true); // holder leaves -> revoke + handoff to longest-present (2)
  assert.deepEqual(rec.revokes.at(-1), { playerId: 1, cellKey: 'a', epoch: 1 });
  assert.equal(auth.holderOf('a'), 2);
  assert.equal(auth.currentEpoch('a'), 2);
  assert.deepEqual(rec.grants.at(-1)!.snapshot, { actors: [{ ref: 'x' }] }); // lastSnapshot handed over

  await auth.onLeave(2, 'a', true); // -> 3
  assert.equal(auth.holderOf('a'), 3);
  assert.equal(auth.currentEpoch('a'), 3);

  await auth.onLeave(3, 'a', false); // last one disconnects -> dormant, snapshot folded, no revoke
  assert.equal(auth.holderOf('a'), undefined);
  assert.equal(auth.currentEpoch('a'), undefined);
  assert.deepEqual(rec.overrides.get('a'), { actors: [{ ref: 'x' }] });
  assert.equal(rec.revokes.filter((r) => r.playerId === 3).length, 0);

  // Re-claim a dormant cell: grant carries the folded overrides, epoch keeps climbing.
  await auth.onEnter(9, 'a');
  assert.equal(auth.holderOf('a'), 9);
  assert.equal(auth.currentEpoch('a'), 4);
  assert.deepEqual(rec.grants.at(-1)!.snapshot, { actors: [{ ref: 'x' }] });
});

test('authority fuzz: invariants hold across random enter/leave/disconnect', async () => {
  const CELLS = ['0,0', '0,1', '1,0', 'interiorcave'];
  const PLAYERS = [1, 2, 3, 4, 5];
  const { auth, rec } = makeAuthority();

  // Test-side mirror of ground truth: which cell each player currently occupies.
  const at = new Map<number, string>();
  const maxEpoch = new Map<string, number>(); // to assert strict monotonicity from grants

  let seed = 0xC0FFEE;
  const rnd = (m: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % m);

  const checkInvariants = () => {
    for (const cell of CELLS) {
      const occupants = [...at.entries()].filter(([, c]) => c === cell).map(([p]) => p);
      const holder = auth.holderOf(cell);
      if (occupants.length === 0) {
        assert.equal(holder, undefined, `empty cell ${cell} must be dormant`);
      } else {
        // Exactly one holder, and it is one of the occupants.
        assert.notEqual(holder, undefined, `occupied cell ${cell} must have a holder`);
        assert.ok(occupants.includes(holder!), `holder ${holder} of ${cell} must occupy it`);
      }
      // Occupant set matches the authority's order list (as a set).
      assert.deepEqual(new Set(auth.occupants(cell)), new Set(occupants), `occupancy mismatch ${cell}`);
    }
    // Strict epoch monotonicity is asserted per-grant in assertGrantMonotonic().
  };

  // Record the max granted epoch per cell as grants arrive; assert each new grant strictly
  // exceeds the previous max for that cell.
  const assertGrantMonotonic = (before: number) => {
    for (let i = before; i < rec.grants.length; i++) {
      const g = rec.grants[i]!;
      const prev = maxEpoch.get(g.cellKey) ?? 0;
      assert.ok(g.epoch > prev, `grant epoch ${g.epoch} on ${g.cellKey} must exceed prev ${prev}`);
      maxEpoch.set(g.cellKey, g.epoch);
    }
  };

  for (let step = 0; step < 4000; step++) {
    const p = PLAYERS[rnd(PLAYERS.length)]!;
    const before = rec.grants.length;
    const here = at.get(p);
    // 0/1: move or enter; 2: leave to nowhere (disconnect); 3: cell-change
    const action = rnd(4);
    if (here === undefined) {
      // offline -> connect into a random cell
      const cell = CELLS[rnd(CELLS.length)]!;
      await auth.onEnter(p, cell);
      at.set(p, cell);
    } else if (action === 2) {
      // disconnect
      await auth.onLeave(p, here, false);
      at.delete(p);
    } else {
      // cell-change to a (possibly same) cell
      const cell = CELLS[rnd(CELLS.length)]!;
      if (cell !== here) {
        await auth.onLeave(p, here, true);
        await auth.onEnter(p, cell);
        at.set(p, cell);
      }
    }
    assertGrantMonotonic(before);
    checkInvariants();
  }

  // Handoff happens within the single onLeave turn: never a window with occupants but no
  // holder (already asserted every step). Final drain: disconnect everyone, all dormant.
  for (const [p, cell] of [...at.entries()]) {
    await auth.onLeave(p, cell, false);
    at.delete(p);
  }
  for (const cell of CELLS) assert.equal(auth.holderOf(cell), undefined);
});
