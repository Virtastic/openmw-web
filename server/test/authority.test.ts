// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Actor-authority state machine: unit invariants plus a randomized fuzz driving
// enter/leave/disconnect across many cells and players.
//
// THE CONTRACT THIS FILE EXISTS TO PIN: only the sim peer ever holds a cell. A player's
// browser never simulates NPCs for anyone else, so a cell with players in it but no peer has
// NO holder and waits — it does not fall back to whoever is nearest.
//
// This file used to test an ELECTION between competing clients (RTT/shed fitness, degrade
// gates, anti-flap cooldowns, settle bias, handoff to the next-best client). All of that only
// had meaning while several connections could hold a cell; with exactly one eligible holder
// there is nothing to rank and nothing to hand off to, so those cases are gone rather than
// rewritten. What survives is claim/info/dormancy, peer-only eligibility, and liveness.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Authority,
  authorityTuning,
  type AuthoritySenders,
  type ActorSnapshot,
} from '../src/core/authority';

// A mirror of what the senders observe, so tests can assert grant/info/revoke traffic.
interface Recorder {
  grants: { playerId: number; cellKey: string; epoch: number; snapshot: ActorSnapshot }[];
  infos: { playerId: number; cellKey: string; holderId: number }[];
  revokes: { playerId: number; cellKey: string; epoch: number }[];
  overrides: Map<string, ActorSnapshot>;
}

const PEER = 1; // the sim peer's player id throughout this file

function makeAuthority(
  opts: { canSimulate?: (id: number) => boolean; review?: boolean; now?: () => number } = {},
): { auth: Authority; rec: Recorder } {
  const rec: Recorder = { grants: [], infos: [], revokes: [], overrides: new Map() };
  const senders: AuthoritySenders = {
    grant: (playerId, cellKey, epoch, snapshot) => rec.grants.push({ playerId, cellKey, epoch, snapshot }),
    info: (playerId, cellKey, holderId) => rec.infos.push({ playerId, cellKey, holderId: holderId as number }),
    revoke: (playerId, cellKey, epoch) => rec.revokes.push({ playerId, cellKey, epoch }),
    loadOverrides: async (cellKey) => rec.overrides.get(cellKey) ?? { actors: [] },
    foldOverrides: async (cellKey, snapshot) => void rec.overrides.set(cellKey, snapshot),
  };
  const auth = new Authority(senders, {
    review: opts.review ?? false,
    caps: { canSimulate: opts.canSimulate ?? ((id) => id === PEER) },
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { auth, rec };
}

test('authority: the peer claims, players are informed, empty cells go dormant', async () => {
  const { auth, rec } = makeAuthority();

  // A player arrives first. It does NOT take the cell — it cannot simulate.
  await auth.onEnter(2, 'a');
  assert.equal(auth.holderOf('a'), undefined, 'a player must never be granted a cell');
  assert.equal(rec.grants.length, 0);

  // The peer arrives and takes it; the player is told who holds it (needed to address actors).
  await auth.onEnter(PEER, 'a');
  assert.equal(auth.holderOf('a'), PEER);
  assert.equal(rec.grants.at(-1)?.playerId, PEER);
  assert.ok(rec.infos.some((i) => i.playerId === 2 && i.cellKey === 'a' && i.holderId === PEER));

  // A second player entering a held cell gets Info, never Grant.
  const grantsBefore = rec.grants.length;
  await auth.onEnter(3, 'a');
  assert.equal(rec.grants.length, grantsBefore, 'entering a held cell must not grant');
  assert.equal(rec.infos.at(-1)?.holderId, PEER);

  // Everyone leaves: the cell is dormant, and its epoch survives for the next claim.
  const epochHeld = rec.grants.at(-1)!.epoch;
  await auth.onLeave(2, 'a', true);
  await auth.onLeave(3, 'a', true);
  await auth.onLeave(PEER, 'a', true);
  assert.equal(auth.holderOf('a'), undefined, 'an empty cell is dormant');

  await auth.onEnter(PEER, 'a');
  assert.ok(rec.grants.at(-1)!.epoch > epochHeld, 'epoch is monotonic across dormancy');
});

test('authority: a cell full of players and no peer stays ownerless', async () => {
  const { auth, rec } = makeAuthority();

  // Six players, none of them able to simulate. Under the old client-authority model the
  // first through the door took the cell and simulated its NPCs for everyone.
  for (const id of [2, 3, 4, 5, 6, 7]) await auth.onEnter(id, 'cell');
  assert.equal(auth.holderOf('cell'), undefined,
    'players alone in a cell must never produce a holder');
  assert.equal(rec.grants.length, 0, 'no grant may be issued to a player, ever');
});

test('authority: when the peer leaves, the cell goes ownerless rather than falling back', async () => {
  const { auth } = makeAuthority();
  await auth.onEnter(PEER, 'cell');
  await auth.onEnter(2, 'cell');
  assert.equal(auth.holderOf('cell'), PEER);

  // The fallback to "the next capable occupant" WAS the client-authority model. Its absence
  // is the point: the actors wait for the server to come back, they do not change hands.
  await auth.onLeave(PEER, 'cell', true);
  assert.equal(auth.holderOf('cell'), undefined,
    'a cell must never fall back to a player when the peer leaves');
});

test('authority: the peer reclaims a cell with the snapshot intact', async () => {
  const { auth, rec } = makeAuthority();
  await auth.onEnter(PEER, 'cell');
  const snap: ActorSnapshot = { actors: [{ ref: 'guard', x: 5 }] } as unknown as ActorSnapshot;
  auth.setSnapshot('cell', snap);

  await auth.onLeave(PEER, 'cell', false); // peer crashed / disconnected
  assert.equal(auth.holderOf('cell'), undefined);

  await auth.onEnter(PEER, 'cell'); // restarted and came back
  assert.deepEqual(rec.grants.at(-1)?.snapshot, snap,
    'the returning peer resumes from the last known actor state, not from nothing');
});

test('authority: a silent peer is reported but KEEPS the cell', async () => {
  let now = 1_000_000;
  const { auth } = makeAuthority({ now: () => now });
  await auth.onEnter(PEER, 'cell');
  await auth.onEnter(2, 'cell');
  // A cell with actors in it: silence here means the peer is not simulating.
  auth.setSnapshot('cell', { actors: [{ ref: 'guard' }] } as unknown as ActorSnapshot);

  now += authorityTuning.actorSilenceMs * 3;
  auth.reviewAll();

  // Revoking would remove the NPCs as well as freeze them, and there is nobody to hand the
  // cell to. The peer keeps it; the operator gets a loud log line.
  assert.equal(auth.holderOf('cell'), PEER,
    'a silent peer must keep the cell — there is no one to hand it to');
});

test('authority: an empty cell never reports a silent holder', async () => {
  let now = 1_000_000;
  const { auth } = makeAuthority({ now: () => now });
  await auth.onEnter(PEER, 'cell');
  // No snapshot => no actors => silence is correct, not a fault.
  now += authorityTuning.actorSilenceMs * 3;
  auth.reviewAll();
  assert.equal(auth.holderOf('cell'), PEER);
});

test('authority fuzz: invariants hold across random enter/leave/disconnect', async () => {
  const CELLS = ['0,0', '0,1', '1,0', 'interiorcave'];
  const PLAYERS = [PEER, 2, 3, 4, 5]; // PEER is the only one that can simulate
  const { auth, rec } = makeAuthority();

  const at = new Map<number, string>();
  const maxEpoch = new Map<string, number>();

  let seed = 0xC0FFEE;
  const rnd = (m: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % m);

  const checkInvariants = () => {
    for (const cell of CELLS) {
      const occupants = [...at.entries()].filter(([, c]) => c === cell).map(([p]) => p);
      const holder = auth.holderOf(cell);
      if (holder !== undefined) {
        // THE invariant: if anything holds a cell, it is the peer, and it is in that cell.
        assert.equal(holder, PEER, `cell ${cell} held by ${holder}, only the peer may hold`);
        assert.ok(occupants.includes(PEER), `holder of ${cell} must occupy it`);
      } else {
        // Ownerless is legal — and REQUIRED whenever the peer is not present.
        assert.ok(!occupants.includes(PEER) || occupants.length === 0,
          `cell ${cell} has the peer in it but no holder`);
      }
      assert.deepEqual(new Set(auth.occupants(cell)), new Set(occupants), `occupancy mismatch ${cell}`);
    }
  };

  const assertGrantMonotonic = (before: number) => {
    for (let i = before; i < rec.grants.length; i++) {
      const g = rec.grants[i]!;
      const prev = maxEpoch.get(g.cellKey) ?? 0;
      assert.ok(g.epoch > prev, `grant epoch ${g.epoch} on ${g.cellKey} must exceed prev ${prev}`);
      assert.equal(g.playerId, PEER, 'every grant must go to the peer');
      maxEpoch.set(g.cellKey, g.epoch);
    }
  };

  for (let step = 0; step < 4000; step++) {
    const p = PLAYERS[rnd(PLAYERS.length)]!;
    const before = rec.grants.length;
    const here = at.get(p);
    const action = rnd(4);
    if (here === undefined) {
      const cell = CELLS[rnd(CELLS.length)]!;
      await auth.onEnter(p, cell);
      at.set(p, cell);
    } else if (action === 2) {
      await auth.onLeave(p, here, false);
      at.delete(p);
    } else {
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

  for (const [p, cell] of [...at.entries()]) {
    await auth.onLeave(p, cell, false);
    at.delete(p);
  }
  for (const cell of CELLS) assert.equal(auth.holderOf(cell), undefined);
});

// A PEER HOLDS CELLS ALL OVER THE MAP (anchors), not just around its own avatar. Its crash
// must release every one of them: releasing only the neighbourhood left the rest owned by a
// dead id forever, and a replacement peer could never take them -- onEnter only INFORMS when
// a foreign holder exists, so the world stayed unsimulated everywhere the old peer was not
// standing. cellsHeldBy is what the disconnect path iterates.
const PEER2 = 3; // the replacement peer after a crash
test('authority: cellsHeldBy names every cell the peer holds, and each can be released', async () => {
  const { auth } = makeAuthority({ canSimulate: (id) => id === PEER || id === PEER2 });
  for (const c of ['a', 'b', 'far']) await auth.onEnter(PEER, c);
  const held = auth.cellsHeldBy(PEER).sort();
  assert.deepEqual(held, ['a', 'b', 'far'], 'every anchored cell must be listed');
  assert.deepEqual(auth.cellsHeldBy(2), [], 'a player holds nothing');

  // The disconnect path releases each in turn; afterwards nothing is held...
  for (const c of held) await auth.onLeave(PEER, c, false);
  assert.deepEqual(auth.cellsHeldBy(PEER), [], 'a crashed peer must hold nothing');
  for (const c of held) assert.equal(auth.holderOf(c), undefined, `${c} still has a holder`);

  // ...and a REPLACEMENT peer can take them all, which is the point.
  for (const c of held) await auth.onEnter(PEER2, c);
  assert.deepEqual(auth.cellsHeldBy(PEER2).sort(), ['a', 'b', 'far'],
    'the replacement peer must be granted the cells the dead one held');
});

// LOSING THE HOLDER MUST BE ANNOUNCED. A client that is never told keeps its holder mirror
// pointing at a peer that is gone: its actor puppets stay attached with AI disabled (frozen,
// unhittable NPCs), and because a real melee swing is cancel-only whenever a holder is
// believed to exist, combat does nothing AT ALL until the client reconnects. The interface
// carried `holderId: undefined` for this and no call site ever passed it -- the client-side
// detach was unreachable code.
test('authority: when the cell goes dormant the occupants are told it is unheld', async () => {
  const { auth, rec } = makeAuthority();
  await auth.onEnter(PEER, 'a');   // the peer takes it
  await auth.onEnter(2, 'a');      // a player is standing there
  rec.infos.length = 0;

  await auth.onLeave(PEER, 'a', false); // the peer crashes
  assert.equal(auth.holderOf('a'), undefined, 'the cell must be dormant');

  const loss = rec.infos.filter((i) => i.cellKey === 'a' && i.holderId === undefined);
  assert.equal(loss.length, 1, 'the remaining occupant must be told the cell lost its holder');
  assert.equal(loss[0]!.playerId, 2, 'told to the player, not to the departed peer');
});
