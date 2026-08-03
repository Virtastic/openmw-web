<!-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app -->
<!-- SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web -->
# D-cap-5 — splitting actor authority within a cell

Design only. Not implemented. **Recommendation as of 2026-07-27: do not build this yet, and
probably not at all.** The reasoning below is the record of why, so a future reader does not
re-derive it or build it on a premise that has since changed.

## Why the premise weakened twice

This item existed because ONE BROWSER TAB simulated every NPC in a cell while also rendering,
interpolating puppets and running the game. Two things have since changed that:

1. **The authority election was fixed.** Most of what looked like holder overload was
   authority thrashing to clients that could not simulate at all. After the fix, `s42`
   (2 browser clients + 20 bots in one retail cell) reports agreement with a median BELOW the
   uncrowded budget.
2. **Phase H moved simulation off browsers entirely.** A headless OpenMW on the operator's
   machine now holds the cell: ~360 MB and ~9% of one core, doing no rendering, no puppet
   interpolation and no per-frame GPU work. The "holder is also a player's game client"
   problem — the entire motivation for splitting — does not exist where a sim peer is
   running.

So the remaining question is narrow: is a DEDICATED machine, doing nothing but simulation,
the binding constraint for a cell? Nobody has measured that, and it is a very different
question from the one this item was opened to answer.

## What would change the recommendation

Build it only if BOTH hold:

- a sim peer's frame time is measurably superlinear in actor count (instrument the peer, not
  a browser client), AND
- a real cell exists that exceeds that budget — Seyda Neen's 11-13 NPCs is nowhere near it.

If a world runs WITHOUT a sim peer (a self-hoster with no game data on the server), the
original concern returns in full. In that case the cheaper lever is the one at the bottom of
this document — reduced-fidelity simulation for actors the holder is not rendering — which
needs no protocol change and no new invariant.

## What the problem was, and what is left of it

One client simulates *every* NPC in a cell and streams their poses to everyone else. That
concentration was the leading explanation for degraded agreement in a crowded cell.

Fixing the authority election changed the picture materially. `s42` (2 browser clients + 20
bots in one retail cell) now reports agreement of **best 36.6, median 59.7, worst 147.2
units** — a median *below* the uncrowded budget of 80 — with the actor stream flowing. Most
of what looked like holder overload was authority thrashing to clients that could not
simulate at all.

**So the honest position is that the remaining holder cost is unquantified.** Splitting is
still directionally right for very busy cells, but building it now would be optimising a
number nobody has measured — the same mistake that produced capacity figures 10x out.

### Establish the need first

1. Instrument the holder: how much frame time does simulating N actors actually cost it?
   The client already mirrors `actorCount`; add a per-frame cost sample alongside it.
2. Run `s42` with a cell that has many more NPCs than Seyda Neen's 11-13. If the holder's
   frame time is flat in actor count, this whole item is unnecessary.
3. Only if the holder is measurably the constraint, proceed.

## If it is needed: the design

Authority becomes per-**partition** rather than per-cell. A partition is a stable subset of a
cell's actors, so `held[cellKey]` becomes `held[cellKey][partition]`.

**Partition by actor ref, not by position.** Position moves; a partition that follows
position reshuffles constantly, and every reshuffle is a handoff (a snapshot plus a re-sync
for every client). Hashing the stable `refKey` into `N` buckets gives a fixed assignment that
survives the actors wandering.

```
partition = hash(refKey) % partitionCount
```

`partitionCount` derives from occupancy so a quiet cell keeps the current single-holder
behaviour exactly: `ceil(actorCount / actorsPerHolder)`, clamped to the number of *capable*
occupants.

### What has to hold

- **Every partition has exactly one holder**, and the union of partitions is the whole cell.
  A gap means frozen NPCs; an overlap means two clients fighting over one actor.
- **Epochs stay per-partition.** M5 routes actor hits to "the cell's holder"; that becomes
  "the holder of that actor's partition". `combat.ts` resolves the ref anyway, so it can
  resolve the partition at the same point.
- **The liveness and capability rules apply per partition** — they are the same checks, just
  scoped narrower.
- **Repartitioning is rare and explicit.** Changing `partitionCount` reassigns every actor,
  so it must be rate-limited hard, exactly like the existing handoff cooldown.

### Where it will bite

- `ActorMoveBatch` carries a cell + epoch today. It gains a partition id, which is a wire
  change and therefore a `PROTOCOL.md` change.
- Cell docs (`actorOverrides`) are per cell. Folding a partition's snapshot back has to merge
  rather than replace, or the last holder to leave wipes the others' state.
- The M4 fuzz test asserts "at most one holder per cell". That invariant becomes per
  partition, and the test must be rewritten rather than relaxed — a weakened invariant here
  would hide exactly the bug the split introduces.

## The cheaper alternative worth pricing first

If the holder's cost turns out to be dominated by the *number of actors it renders as well as
simulates*, a smaller change may capture most of the benefit: let the holder simulate actors
it is not rendering at reduced fidelity, the way G2 does for avatars. That needs no protocol
change, no partitioning, and no new invariant — and G2 showed the ordering assumptions here
are easy to get backwards, so measure before committing to the larger design.
