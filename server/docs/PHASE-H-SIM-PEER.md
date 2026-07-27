<!-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app -->
<!-- SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web -->
# Phase H — server-side simulation (headless authority peer)

**Goal.** Actor simulation moves off players' browsers and onto a machine the operator
controls, for public worlds, private sessions and parties alike, spun up on demand.

**Why it is worth doing.** It fixes a whole class of problem at the root rather than
mitigating it: no player carries anyone else's load, no election or handoff, no frozen NPCs
when someone's tab is loading — and, most importantly, **a modified client can no longer
author NPC state for everyone else**, which is the single largest anti-cheat hole in the
current design.

**Why it is not free.** Simulating Morrowind requires Morrowind's engine and data. This is
not a server rewrite; it is running a real OpenMW instance with rendering disabled. TES3MP
kept simulation on clients for exactly this reason, so treat "just make the server
authoritative" as a claim to be proven, not assumed.

---

## H1 — SPIKE FIRST (gating, ~1 day)

**Nothing below is worth planning in detail until this answers yes.**

0. **Can the repo even build OpenMW natively?** `deps/` currently holds only the wasm
   sysroot and there is no `build-native`. A native build needs OSG, Bullet, MyGUI, ICU and
   friends first, which on this machine is hours, not minutes. Budget it, or evaluate
   running the EXISTING wasm build under Node instead (it hits the same GL question, so the
   crux below is unchanged either way).
1. **Can OpenMW initialise without a GL context?** It is not built for headless operation and
   much of its startup assumes a window and a renderer. Options in increasing desperation:
   an offscreen context (EGL/OSMesa), a null OSG graphics context, or patching the render
   path out of the boot sequence. The spike's job is to find which is needed and how invasive
   it is.
2. **Does it still simulate with no renderer?** AI, pathfinding, physics and MWScript must
   run. A build that boots headless but does not tick actors is worthless.
3. **What does it cost?** RSS and CPU for one instance simulating one world's active cells.
   This number decides whether per-session peers are affordable at all (see H4).

### What a first read of the engine suggests (analysis, NOT proof)

Two things make this look more tractable than "OpenMW has no headless mode" implies, and the
spike should test them directly rather than starting from scratch:

- **The frame is already three separable traversals.** `engine.cpp` runs
  `mViewer->eventTraversal()`, `updateTraversal()`, then `renderingTraversals()`. The world,
  physics and AI tick in the update traversal; drawing is the third call. A headless mode may
  be as narrow as *skipping the third* — simulation without any GPU work per frame.
- **The GL dependency is concentrated at INIT, not per frame.** `createWindow()` runs early in
  `prepareEngine()` and everything that matters — Lua, `MWWorld::World`, physics, the script
  manager — is constructed after it. So the likely shape is: a HIDDEN window with a real
  (software) GL context so `RenderingManager` can construct, then skip rendering every frame.

If that holds, the patch is small and targeted rather than deep surgery on the render path.
It also means the peer pays for a GL context once at startup and no per-frame draw cost,
which matters a great deal for the per-peer cost in H4.

**Treat all of the above as a hypothesis to falsify.** It is a read of the call order, not a
working build, and this project has already had one confident mechanism turn out wrong.

Exit criteria: a headless build that loads a cell, ticks NPCs for a minute, and reports its
RSS/CPU. If that cannot be reached in about a day, stop and reconsider — D-cap-5 (splitting
authority across players) becomes the fallback, and the current model still works.

## H2 — native WebSocket transport

`apps/openmw/mwmp/websocket.cpp` wraps the **emscripten** WebSocket API; on native builds
every method is a deliberate no-op so the tree still compiles for desktop. A headless peer
therefore cannot connect at all today.

Add a native implementation behind the same `MWMP::WebSocket` interface (IXWebSocket or
Boost.Beast; the interface is already narrow — open, send text, send binary, close, four
callbacks). The browser path must be left exactly as it is: it is proven, and this is
additive.

## H3 — the peer as an authority client

The peer connects like any other client and **needs no new protocol**: cell authority already
requires `simulatesActors: true` (added when protocol-only bots were found winning elections
and freezing cells). A local peer declares it, has near-zero RTT, and wins every election
through the existing fitness path.

What it does need:

- **A system identity.** Not in the player list, not kickable, not counted against
  `maxPlayers`, exempt from the idle/AFK paths.
- **Preference, not a guarantee.** If the peer dies, the existing election must still fall
  back to a capable player client. The peer is an upgrade, not a hard dependency — a
  self-hoster with no game data on the server must still get a working game.
- **Liveness already covered.** A peer that stops producing loses its cells through the
  guard that already exists.

## H4 — on-demand orchestration (public, private, party)

This is the requirement that makes Phase H big, and it revives E1.

| mode | peer lifetime |
| --- | --- |
| public world | one long-lived peer, started with the world |
| private session | started when the session is created, reaped when empty |
| party | same as private, keyed on the party |

**Cost per peer is the deciding number and it is currently unknown** — H1 measures it. A full
OpenMW instance with game data loaded is likely hundreds of MB, so "one per party" may be
affordable at ten sessions and not at a hundred. Design the reaper before the spawner:
per-user session caps and idle reaping are day-one requirements, because the cost model goes
from one process to N.

Cheaper variants to price if the per-peer cost is high:
- **One peer, many worlds** — a single instance simulating several sessions' cells, if the
  engine can hold multiple worlds at once (it probably cannot; check before assuming).
- **Peer only for the public world**, with private/party sessions keeping client authority.
  Most of the anti-cheat value lives in the public world anyway.

## H5 — what this buys for anti-cheat, precisely

Worth being exact, because "server authoritative" is often claimed too broadly.

**Closed by this work:**
- NPC positions, AI state and deaths stop being author-able by a player's client.
- Actor combat resolution moves to the operator's machine: M5 routes actor hits to the
  authority holder, and the holder becomes the peer.

**Not closed, and not by this alone:**
- **Player self-movement stays client-authored.** That is deliberate — it is what makes the
  game feel responsive, and making the server authoritative over input is a much larger
  change that would hurt play more than it helps. The peer *can* now validate it (it has
  collision and speed data), so speed/teleport/no-clip checks become possible for the first
  time; that is a follow-on, not part of H3.
- Client-reported player stats and inventory remain trusted within the existing plausibility
  caps.

So: this closes the largest hole and makes a second class of check possible. It does not make
the game cheat-proof, and the docs should not claim it does.

## Sequencing

1. **H1 spike** — gating. Everything else is speculative until it lands.
2. **H2 native transport** — well-understood, can proceed in parallel once H1 looks viable.
3. **H3 peer identity + preference + fallback** — small, mostly server-side.
4. **H4 orchestration** — sized by H1's cost number; reaper before spawner.
5. **H5 movement validation** — separate follow-on, only once the peer is real.

## Verification

- A cell's NPCs are simulated with **no player holding authority**.
- Killing the peer falls back to a player client within the existing handoff window, and
  killing it again while a player holds it changes nothing.
- A modified client's forged `ActorMoveBatch` is ignored (it is not the holder), which is
  the anti-cheat claim made concrete rather than asserted.
- Cost per peer published like every other capacity figure: measured on an idle box, with
  the host load recorded.
