// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M4 authority state machine: unit invariants + a randomized fuzz driving enter/leave/
// disconnect across many cells and players, asserting the authority invariants after
// every step.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Authority,
  authorityTuning,
  type AuthoritySenders,
  type ActorSnapshot,
  type FitnessSource,
  type PlayerFitness,
} from '../src/core/authority';

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

// ------------------------------------------------------------ fitness election
// A fake fitness source + a driven clock, so election is exercised as a pure function of
// (score, age) rather than by sleeping. `review: false` kills the self-timer: these tests
// call reviewAll() explicitly, so a sweep can never land between assertions.
function makeTuned(): {
  auth: Authority;
  rec: Recorder;
  rtt: Map<number, number>;
  tick: (ms: number) => void;
} {
  const rec: Recorder = { grants: [], infos: [], revokes: [], overrides: new Map() };
  const rtt = new Map<number, number>();
  const fitness: FitnessSource = {
    get: (id): PlayerFitness | undefined => {
      const r = rtt.get(id);
      return r === undefined ? undefined : { rttMs: r, shedRate: 0, samples: 10 };
    },
  };
  let clock = 1_000_000;
  const senders: AuthoritySenders = {
    grant: (playerId, cellKey, epoch, snapshot) => rec.grants.push({ playerId, cellKey, epoch, snapshot }),
    info: (playerId, cellKey, holderId) => rec.infos.push({ playerId, cellKey, holderId }),
    revoke: (playerId, cellKey, epoch) => rec.revokes.push({ playerId, cellKey, epoch }),
    loadOverrides: async (cellKey) => rec.overrides.get(cellKey) ?? { actors: [] },
    foldOverrides: async (cellKey, snapshot) => void rec.overrides.set(cellKey, snapshot),
  };
  const auth = new Authority(senders, { fitness, now: () => clock, review: false });
  return { auth, rec, rtt, tick: (ms) => void (clock += ms) };
}

const SETTLED = () => authorityTuning.settleMs + 1;

test('authority: handoff picks the fittest settled candidate, not the longest-present', async () => {
  const { auth, rec, rtt, tick } = makeTuned();
  rtt.set(1, 30); // holder
  rtt.set(2, 300); // longest-present remainder, but a bad link
  rtt.set(3, 25); // fittest
  await auth.onEnter(1, 'a');
  await auth.onEnter(2, 'a');
  await auth.onEnter(3, 'a');
  tick(SETTLED()); // everyone is settled, so seniority no longer shields 2

  await auth.onLeave(1, 'a', true);
  assert.equal(auth.holderOf('a'), 3, 'fittest remaining wins the forced handoff');
  assert.equal(auth.currentEpoch('a'), 2, 'epoch advances exactly once');
  assert.equal(rec.grants.at(-1)!.playerId, 3);
  // The epoch moved: every remaining non-holder is told, in the same turn.
  assert.deepEqual(
    rec.infos.filter((i) => i.holderId === 3).map((i) => i.playerId),
    [2],
  );
});

test('authority: a just-arrived candidate is not elected while a settled one exists', async () => {
  const { auth, rtt, tick } = makeTuned();
  rtt.set(1, 30);
  rtt.set(2, 200);
  await auth.onEnter(1, 'a');
  await auth.onEnter(2, 'a');
  tick(SETTLED());
  rtt.set(3, 1); // a perfect link that just walked in — and may walk straight out
  await auth.onEnter(3, 'a');

  await auth.onLeave(1, 'a', true);
  assert.equal(auth.holderOf('a'), 2, 'unsettled 3 is held back despite the better score');

  // With no settled candidate left, the newcomer is electable: an occupied cell must
  // always have a holder.
  await auth.onLeave(2, 'a', true);
  assert.equal(auth.holderOf('a'), 3);
});

test('authority: ties and near-ties keep the incumbent', async () => {
  const { auth, rec, rtt, tick } = makeTuned();
  rtt.set(1, authorityTuning.degradeScoreMs + 50); // bad enough to open the degrade gate
  rtt.set(2, authorityTuning.degradeScoreMs + 50); // exactly as bad
  await auth.onEnter(1, 'a');
  await auth.onEnter(2, 'a');
  tick(SETTLED());
  const epoch = auth.currentEpoch('a');

  tick(authorityTuning.sustainMs + 1);
  auth.reviewAll();
  assert.equal(auth.holderOf('a'), 1, 'an exact tie is not "clearly better"');

  // Better, but only by a jitter-sized margin: still not worth a snapshot + re-sync.
  rtt.set(2, authorityTuning.degradeScoreMs + 50 - (authorityTuning.improveMs - 1));
  auth.reviewAll();
  assert.equal(auth.holderOf('a'), 1);
  // ...and better absolutely but not by the ratio (both links are hopeless anyway).
  rtt.set(1, 4000);
  rtt.set(2, 3200); // 800 ms better, but 3200 > 4000 * 0.75
  auth.reviewAll();
  assert.equal(auth.holderOf('a'), 1);
  assert.equal(auth.currentEpoch('a'), epoch, 'no epoch churn while the incumbent stands');
  assert.equal(rec.revokes.length, 0);
});

test('authority: a degrading holder is replaced only after the sustained window', async () => {
  const { auth, rec, rtt, tick } = makeTuned();
  rtt.set(1, 20);
  rtt.set(2, 20);
  await auth.onEnter(1, 'a');
  await auth.onEnter(2, 'a');
  tick(SETTLED());

  rtt.set(1, 900); // holder's link falls over
  auth.reviewAll();
  assert.equal(auth.holderOf('a'), 1, 'one bad sample must not move authority');

  tick(authorityTuning.sustainMs - 1);
  auth.reviewAll();
  assert.equal(auth.holderOf('a'), 1, 'still inside the sustain window');

  // Recovery resets the clock: the gate is on a CONTINUOUS bad stretch, not a total.
  rtt.set(1, 20);
  auth.reviewAll(); // clears badSince
  rtt.set(1, 900);
  auth.reviewAll(); // re-arms it, from NOW
  tick(authorityTuning.sustainMs - 1);
  auth.reviewAll();
  assert.equal(auth.holderOf('a'), 1, 'recovery re-armed the window');

  tick(2);
  auth.reviewAll();
  assert.equal(auth.holderOf('a'), 2, 'sustained degradation hands off');
  assert.equal(auth.currentEpoch('a'), 2);
  assert.deepEqual(rec.revokes.at(-1), { playerId: 1, cellKey: 'a', epoch: 1 }); // revoked at the OLD epoch
  assert.equal(rec.grants.at(-1)!.playerId, 2);
  assert.deepEqual(
    rec.infos.filter((i) => i.holderId === 2).map((i) => i.playerId),
    [1],
    'the displaced holder is told who took over',
  );
});

test('authority: jitter across the degrade threshold produces no handoff at all', async () => {
  const { auth, rec, rtt, tick } = makeTuned();
  rtt.set(2, 20); // a permanently better candidate is always sitting right there
  rtt.set(3, 20);
  await auth.onEnter(1, 'a');
  await auth.onEnter(2, 'a');
  await auth.onEnter(3, 'a');
  tick(SETTLED());

  // The realistic case: the holder's link wobbles either side of the gate. Because every
  // good sample re-arms the sustain window, a wobble never accumulates into a handoff —
  // only a genuinely persistent degradation does.
  for (let i = 0; i < 200; i++) {
    rtt.set(1, i % 2 === 0 ? authorityTuning.degradeScoreMs + 400 : authorityTuning.degradeScoreMs - 10);
    tick(20_000); // 20 s per step: without the reset, 200 steps is 66 sustain windows
    auth.reviewAll();
  }
  assert.equal(auth.holderOf('a'), 1, 'jitter never unseats the incumbent');
  assert.equal(auth.currentEpoch('a'), 1, 'and never burns an epoch');
  assert.equal(rec.revokes.length, 0);
});

test('authority: flapping RTT does not produce repeated handoffs', async () => {
  const { auth, rec, rtt, tick } = makeTuned();
  await auth.onEnter(1, 'a');
  await auth.onEnter(2, 'a');
  await auth.onEnter(3, 'a');
  tick(SETTLED());

  // A pathological series: whoever currently holds authority is always the worst, and by a
  // margin that clears both improvement gates. Without damping this is one handoff per
  // review — the exact failure mode that costs a snapshot + re-sync every time.
  let seed = 12345;
  const rnd = (m: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % m);
  for (let i = 0; i < 400; i++) {
    const holder = auth.holderOf('a')!;
    for (const p of [1, 2, 3]) rtt.set(p, p === holder ? 700 + rnd(200) : 20 + rnd(30));
    tick(5_000);
    auth.reviewAll();
  }

  const handoffs = rec.revokes.length;
  // 400 reviews * 5 s = 2000 s of pure flapping. The cooldown alone caps re-elections at
  // one per cooldownMs; assert well inside that so the bound is meaningful, not tautological.
  const ceiling = Math.ceil((400 * 5_000) / authorityTuning.cooldownMs) + 1;
  assert.ok(handoffs <= ceiling, `${handoffs} handoffs exceeds the damped ceiling ${ceiling}`);
  assert.ok(handoffs > 0, 'damping must not mean "never hand off"');
  // Epoch churn is the real cost, and it tracks handoffs exactly.
  assert.equal(auth.currentEpoch('a'), 1 + handoffs);
});

test('authority: a lone holder is never re-elected, however bad its link', async () => {
  const { auth, rec, rtt, tick } = makeTuned();
  rtt.set(1, 5000);
  await auth.onEnter(1, 'a');
  tick(SETTLED() + authorityTuning.sustainMs + 1);
  auth.reviewAll();
  assert.equal(auth.holderOf('a'), 1, 'nobody to hand to: a bad holder beats no holder');
  assert.equal(rec.revokes.length, 0);
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
