<!-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app -->
<!-- SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web -->
# openmw-web multiplayer — state of play

Branch `multiplayer`, committed locally, **never pushed**. Written to be read cold.

## What exists

Milestones M0–M8 (session, movement, player state, world objects, cell actor authority,
combat, quests, world state, ops), plus:

| | |
| --- | --- |
| **A** hardening | auto-reconnect with jitter, `/metrics`, restore drill, moderation tooling |
| **B** SSO | OAuth2 + PKCE via a Backend-For-Frontend; accounts keyed on `(iss, sub)`, never email |
| **C** social | friends, presence modes, invites, party — server, client hub, end-to-end scenario |
| **E3** admin | in-game window whose menu is generated from the server's own rank-filtered `/help` |
| **G1** scaling | broadcaster spatial index — cost linear in population, not quadratic |
| **G2** scaling | avatar render LOD — client cost bounded by a cap, not by population |
| **M4** correctness | cell authority now requires a client that can actually SIMULATE (`simulatesActors`), plus a liveness guard that revokes a holder producing nothing |

## What is verified, and how

- **316 server tests**, several negative-controlled (the control is broken deliberately to
  confirm the test fails).
- **32 browser scenarios** driving real headless clients against a real server.
- **Pressure**: 24 bots / 6 cells / 12 min — no leaks, no drops, ping 1 ms mean, journal
  monotonic, no record-id collisions.
- **UI/UX**: `s46` drives the windows and screenshots each step.
- **Capacity**: 64 co-located avatars at 48 fps; see README "Measured capacity".
- **Crowded cell**: 2 browser clients + 20 bots — actor stream flowing, agreement median
  59.7 units (below the uncrowded budget).

## Known open

| item | state |
| --- | --- |
| **D-cap-5** — split actor authority within a cell | Not built. The right next lever for combat-heavy crowds: one client simulating every NPC is what degrades aim fidelity at 20+ per cell. |
| **F2** — 256-player ceiling | Not measured. `wasm-build/measure-256.sh` runs it. Extrapolation says server-spread is fine and the wall is CLIENT MEMORY; that is a guess until run. |
| **Upstream `DelayedAction`** errors | OpenMW's own menu scripts, present before our changes, harmless so far. |
| **Human playtest** | `PLAYTEST.md` §10 + the social/LOD sections. Nothing automated can answer "does it feel right". |

## Needs a human

1. **Rotate the Google `client_secret`** — it was pasted into a chat transcript. Nothing is
   pushed and `devdata/` is gitignored, so it is not in git; rotate before anything is public.
2. **Discord + Microsoft credentials.** Redirect URIs must be registered byte-for-byte as
   `https://<host>/auth/{provider}/callback`.
3. **Deploy decision.** Infra is staged and has never fired; it needs a go-ahead and a
   destination (likely routing `/auth/*` and `/ws` on `morrowind.virtastic.app`).

## Two things worth knowing before trusting a number

**Capacity figures were published once that were 10x wrong.** They were measured while the
host was at load 54–131. The corrected figures are in the README with an explicit note.
Every capacity script now prints host load around each phase. **Do not quote a number taken
above roughly load 10.**

**Several bugs were found by tooling, not by tests failing.** Four of the nine real defects
this cycle were sitting underneath green runs, and surfaced only once the harness started
reporting Lua errors and capturing screenshots. A throwing engine handler disables its whole
subsystem silently — the suite stays green because the assertions are satisfied by some other
path. If a subsystem misbehaves, read the client log for `Lua error` **before** forming a
hypothesis; that would have saved two wrong theories and two rebuilds on the last one.

**A plausible mechanism is not a diagnosis.** Crowd divergence was published with an
explanation attached (frame-time steering lag) that was simply wrong — it was authority
thrashing to clients that could not simulate. Effort then went into widening a test budget
to accommodate what was a bug. The server counters that eventually settled it existed the
whole time. Attribute a number before explaining it.

**Kill orphaned harness processes before trusting a measurement.** Stopping a background
task kills the shell, not the child `node`. One harness ran for 20 hours competing with
every gate, and a good share of what was written off as "the host is busy" was that. Check
`ps -Ao command | grep '[m]p-harness'` before believing a load-related excuse.
