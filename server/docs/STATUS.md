<!-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app -->
<!-- SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web -->
# openmw-web multiplayer — state of play

## 2026-09-02 — the mp912026 overhaul: one peer, input authority, Solo/Party (proto 2)

Branch `multiplayer912026`, local commits only. Server authoritative for movement via a
single sim peer per world holding EVERY occupied cell (position anchors, not cell centres —
the loaded-but-frozen ring is fixed at `nearestSimDistanceSqr`). Players send raw input
(0x0102, ~30 Hz); the peer's input-driven AVATARS (`avatar.lua`) produce the authoritative
poses (0x0105), fanned out on the ordinary move channel with the owner reconciling against
0x0103 via capped `mp.correctSelf` + hard snap. The peer also reports avatar BARS
(`AvatarStatsBatch` → owner `MP_SelfStats`). Every peer answer only rules a player actively
driving the input tier — per-player degraded mode, no switchover signal, old clients and
bots keep client authority. World model collapsed to Solo/Party (friends are the only door,
cap 32, no public world, no party concept); Save/Load removed in every MP session; proto 2
+ `omw-mp.2` refuse old clients with `BAD_PROTO`.

**Verified in play** (wasm-build/mp-harness.mjs under Dockerfile.harness-peer, full branch
on both sides): s01 login, s40 NPC sim (one peer, cell owner is neither client), s51 NPC
combat (dies once for everyone), s59 spell-forward (both players see the kill). s42 passed
under the input gate; on the wasm64 client the measurement needs a quieter box. Server
suite 993/1001 (2 known env failures), Lua suite 60/60.

**Hard-won, do not relearn:** the headless peer SIGSEGVs by infinite recursion in
`MyGUI::LogManager::getInstance()` if ANY MyGUI singleton is touched (NullWindowManager
never initialises MyGUI) — every reachable caller is guarded (LuaUi elements, input modal
check, message-box formatting). `avatar.lua` must be registered in `mp.omwscripts`. An
identical appearance relay must NOT rebuild a puppet — on the peer that tore avatars down
every ~8 s. The avatar deliberately never swings (use bit unmapped): melee stays on the
attacker-detects relay applied once on the peer, or every swing lands twice.

**Deferred with intent:** attacker-side melee/cast migration (needs the discrete-intent
tier), inventory request→result (needs a vetoing engine hook; `OnItemTransferred` is
notify-only), progression reporting peer→server, E1 measurement, E4 deep trim.

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
| **H** server-side simulation | a headless OpenMW (`OPENMW_HEADLESS=1`) connects as a system client and holds cell authority, spawned on demand and reaped when idle. NPCs are simulated on the operator's machine, not in a player's browser. **MANDATORY since 1.1.0** — a server that cannot run one refuses to boot, because it is the only thing permitted to simulate actors. **Measured 468–487 MB** (see below); the "~360 MB, OFF by default" this row used to claim was true of neither by then. |

## What is verified, and how

- **Double gate PASSED 2026-07-27**: the full 32-scenario browser suite green TWICE
  consecutively (32/32, 32/32), the second run on a genuinely quiet box (load 2.6), plus the
  singleplayer smoke green (boots, renders, no context loss).
- **329 server tests** at the double gate; **698** now, and every behaviour added since is
  negative-controlled (the guard is broken deliberately and the test confirmed to fail).
- **Anti-cheat is now a test, not a claim**: a non-holder's forged `ActorMoveBatch` is
  rejected, counted and relayed to nobody, while the real holder's still flows.
- **32 browser scenarios** driving real headless clients against a real server. (That was the
  count at the double gate; the suite is **42** now.) The engine builds again and **12 of those
  were run here for the first time — 6 pass, 6 fail, every failure with a named cause and none
  of them the engine.** The whole quest layer is verified through real browsers against real
  retail data. Four are structurally obsolete and one needs `content/`; see "Verified" below.
- **Pressure**: 24 bots / 6 cells / 12 min — no leaks, no drops, ping 1 ms mean, journal
  monotonic, no record-id collisions.
- **UI/UX**: `s46` drives the windows and screenshots each step.
- **Capacity**: 64 co-located avatars at 48 fps; see README "Measured capacity".
- **Crowded cell**: 2 browser clients + 20 bots — actor stream flowing, agreement median
  59.7 units (below the uncrowded budget).

## Known open

**Combat: a dropped hit is a lost swing, and the player is not told.** Reported from a live
server as "hits are not registering, or showing misses".

**A contract mismatch was found and fixed, but it is NOT the explanation for that report, and an
earlier version of this section said it was.** `combat.lua` refused to forward an attack whenever
it had no authority epoch for the target's cell, while `combat.ts` validates the epoch *only when
supplied* and proves presence by proximity instead — its own test, "non-holder may omit epoch;
proximity is the presence proof", pins that. The client was the strict side and dropped the swing
itself, after `puppet.lua`'s onHit interceptor had already cancelled the local damage. Aligning
the client with the server's tested contract is right on its own merits.

**What made the first write-up wrong** was reasoning from the server's comment ("the attacker is
usually a NON-holder, and until it has seen an ActorAuthorityInfo/Grant it has no legal epoch to
quote") without checking the client. `actors.lua` sets `infoEpoch[cellKey] = data.epoch` in the
SAME `MP_ActorAuthorityInfo` handler that calls `attachActorPuppets(cellKey)` — so an actor is
only ever a puppet in a cell whose epoch the client already knows. The two arrive together. The
epoch is therefore nil only in narrow cases: an Info that carried none (older servers), or a
puppeted actor that has since WANDERED into a cell the client has no epoch for. Real, worth
fixing, and not what a player hitting an NPC in front of them experiences.

This was caught by a negative control, not by review: `s58-combat-forward` was written to prove
the fix end to end, and it **passes with the fix reverted** — because by the time the client
swings it already holds the epoch. The scenario is still worth having (it is the first browser
coverage of M5 routing at all), but it covers the JOURNEY, not the epoch-absent branch, and it is
labelled that way now.

**The likely explanation for the actual report is now FIXED: a cell that had a holder and lost
it.** The puppets stay attached, the epoch stays known, the client sends — and the server used to
discard it with `cell has no authority holder`, losing the swing in silence.

A cell with no holder is a MOMENTARY state (the sim peer restarting, or not yet covering it), so
the swing is now PARKED rather than thrown away, and delivered when the cell is granted
(`combat.ts` `hold`/`flushCell`, wired from `worldstate.ts`'s grant callback). Bounded in both
directions, because a queue is how a brief outage becomes a stampede: **6 s** (past that the fight
has moved on and landing an old hit is worse than dropping it) and **64 per cell** (enough for a
party mid-fight, far below what an attacker could use to make the server hold state for them; the
oldest is dropped first, since recent swings are the ones still worth landing). Delivery re-runs
the ordinary path, so proximity, epoch and the damage cap all apply to it exactly as they would
have to the original.

`omwmp_combat_held_total{outcome=held|delivered|expired}` makes the difference visible: `held`
rising with `delivered` is a peer restarting and recovering; `held` rising with `expired` is a
peer that is not coming back.

A STALE epoch is deliberately NOT parked — that client is addressing a simulator generation that
is gone, so holding it would only deliver it to the wrong one. It is refused, and said, via
`CombatRefused`. Negative-controlled: reverting `hold` to a drop fails the parked-swing test.

### The full scan the attack bug prompted

The attack bug has a shape — *the client is stricter than the server, or the server sends
something the client never handles, and the player is told nothing* — so every surface was
diffed rather than spot-checked. Mechanically: every `mp.sendEvent` in `scripts/mp` against
every inbound handler in `server/src`, and every `sendEvent` in `server/src` against every
`MP_*` handler in `scripts/mp`.

**Found and fixed — two server->client events that no client handled.** A server event with no
handler is not an error anywhere: it arrives, matches nothing, and is dropped in silence, so the
server half looks complete and tested while the feature is dead.
- `WorldTimeRefused`. `m7.ts` refuses a Rest/Wait under `[rules] timeSkip` and says so
  deliberately — its comment is *"Refusals are TOLD to the player — a Rest that silently does
  nothing gets pressed again and then reported as a bug"*. The telling never arrived. This
  matters more since this cycle: the public world now ships `timeSkip = "off"`, so resting in
  the lobby is on the path of every visitor, and it did nothing and said nothing.
- `SocialNotice` — kicked from a party, or the leader left and it disbanded. Sent precisely so
  the party does not evaporate with nobody knowing why; nobody knew why.

**Found and FIXED — spell damage never propagated at all.** `server/PROTOCOL.md` §M5 documents
four combat messages and `combat.ts` implements all four; only `CombatHit` was ever SENT. Casting
at an NPC or a player did nothing: the caster's client damaged its own puppet copy, the owner was
never told, and the next stats push reverted it.

**The cause was an asymmetry between melee and magic, not a missing message.** Melee works because
the engine hands damage application to Lua — the `Hit` local event — so `puppet.lua` intercepts
it, returns `false` to cancel, and forwards. Magic is applied by the engine itself in
`mwmechanics/spelleffects.cpp`, and its only Lua notification (`Class::onHit`, `class.hpp:150`)
returns `void` and is queued. Nothing could veto it, so the damage was always applied locally and
never forwarded. Adding the missing notification would have made it WORSE — applied locally *and*
forwarded, which is the double-application M5 exists to prevent.

**The fix is a synchronous seam**, in project-owned code except for one guarded gate:
- `openmw/apps/openmw/mwmp/puppets.{hpp,cpp}` — a registry of actors a remote peer simulates,
  queryable in the same call. New file, entirely ours.
- `mp.setPuppet` / `mp.takeMagicHits` in `mwmp/luabindings.cpp` — Lua marks puppets as it
  attaches and detaches them, and drains the effects the engine declined to apply.
- `spelleffects.cpp` — under `#ifdef __EMSCRIPTEN__`, ask `MWMP::isPuppet` before applying; if it
  is somebody else's actor, park the effect instead. The desktop path is byte-for-byte intact per
  `WASM_ADAPTATIONS.md`, and the registry is empty in singleplayer so the check is a lookup
  against an empty set.
- `puppet.lua` / `combat.lua` — mark, drain, and forward over `CombatSpellHit`, the message the
  server had always implemented and nobody sent.

**A second bug was hiding behind the first.** With spells finally arriving, every application on
the owner threw `vector::_M_range_check: __n (which is 1) >= this->size() (which is 1)`:
`combat.lua`'s inbound applier built **1-based** effect indexes, while `activeSpells:add` indexes
the spell record's effect list from **0** (`effects = { 0 }` in the API docs). It would have
thrown on every forwarded spell hit for as long as the feature had existed — invisible, because
nothing had ever sent one to receive.

**Verified end to end** by `s59-spell-forward`: a real browser casts a real content spell at a
real NPC, the damage is withheld locally, routed through the server to the simulating peer,
applied there — and the NPC dies, seen by BOTH players. `peer apply failures: 0`.

**One deployment hazard this exposed, worth knowing before shipping a script change:** the sim
peer image ships its OWN copy of `scripts/mp` under its resources tree, and `resources=` wins over
any later `data=` line. A client-script fix therefore reaches the browsers and NOT the peer, and
the symptom points at neither — the browser forwards correctly while the peer fails on old code.
`mp-harness.mjs` now syncs the working tree over the peer's copy before spawning it; a real
deployment must rebuild `openmw-simpeer:local` whenever `scripts/mp` changes.

### Why four scenarios broke when the sim peer landed (two fixed, two skipped)

Running them for the first time found this immediately. `s40-npc` asserts, in its own header,
"two clients in the same retail cell; **exactly ONE is the authority holder**" — and fails with
`exactly one client must hold cell authority: 0 !== 1`.

It cannot ever pass again. `worldstate.ts` `canSimulate` is now `return p.system === true` — only
the sim peer may hold a cell, deliberately and with no knob:

> ONLY the sim peer may hold a cell. Not a knob: it was tied to `auth.requireSso`, which has
> nothing to do with who simulates NPCs — so a non-SSO server silently fell back to letting a
> PLAYER'S BROWSER author NPC state for everyone.

That change was right. What went unnoticed is that it retired the browser coverage for the whole
M4/M5 layer: **`s40-npc`, `s41-authority-handoff`, `s42-crowded-cell` and `s51-npc-combat`** were
all written against client-held authority.

**Two of the four are now closed rather than merely documented.**

- **`s41` is rewritten and PASSES.** Handoff between clients cannot be tested because there is no
  second eligible holder, so it now tests the property that REPLACED it — and which nothing
  anywhere covered: a client never holds a cell, however it asks. Three steps: a lone browser
  takes nothing and the cell has no holder at all; a protocol client that DECLARES
  `simulatesActors` (the client-authored flag `canSimulate` was rewritten to stop believing) is
  refused; and a system peer then gets the grant, with the browser correctly seeing the peer as
  holder while still holding nothing itself. **Negative-controlled and the control was RUN** —
  relaxing `canSimulate` back to `p.system === true || p.simulatesActors === true` fails it on
  the first assertion, "a browser client took cell authority".
- **`s51`'s routing half is covered by the new `s58-combat-forward`**, which drives a real engine
  swinging at a real Seyda Neen NPC through the server to a real holder. Read its header before
  trusting it to police the epoch fix: it does not, and the negative control is what proved that.

**All four are now closed, and they PASS.** This was called unfixable twice in this document
and was neither time. `wasm-build/Dockerfile.harness-peer` runs the native headless OpenMW beside
the browsers; `ctx.startSimPeer(cellKey)` starts one.

| | |
| --- | --- |
| `s40-npc` | **PASS** — `cell owner=1`, both clients puppeting 13 NPCs, 11 shared NPCs converged to 78.5u (budget 80) |
| `s41-authority-handoff` | **PASS** — rewritten: a client never holds a cell, however it asks |
| `s42-crowded-cell` | **PASS** — 2 browsers + 20 bots, 22 players, divergence median 108u under load |
| `s51-npc-combat` | **PASS** — both players hit the same NPC, it dies once, shared tally = 1 |

`s51` is the one that matters for the reported bug: **two real browsers attacked an NPC, their
hits routed through the server to the simulating peer, the peer applied the damage, the NPC died,
and both players saw it exactly once.** That is combat verified in play rather than argued from
unit tests.

Their assertions were rewritten for the model that exists, and the rewrites are stronger than the
originals. "Exactly one CLIENT holds the cell" became "the cell has an owner and it is NEITHER
client, and all clients agree WHICH owner". `s40`'s kill check was **inverted**: it used to kill
on the holding client and watch the death relay, which is precisely the unilateral authorship
`canSimulate` exists to prevent, so it now asserts a client's local kill reaches nobody. `s42`'s
"authority must not leave the holder" became "the cell must not lose its owner", because there is
no fitter client to re-elect to any more.

**Four things had to be right, and three were mistakes worth recording:**

1. *Base image.* Adding the peer to Debian bookworm fails (glibc 2.36 vs the binary's 2.39).
   Rebasing on trixie and quarantining Ubuntu's `.so` closure gets `openmw --version` running
   with zero missing libraries and then SEGFAULTS booting the game — and putting Ubuntu's
   `libc.so.6` on `LD_LIBRARY_PATH` kills node and chromium too
   (`undefined symbol: __nptl_change_stack_perm`). **Do not retry that.** Keep the peer in its own
   Ubuntu image and install `google-chrome-stable` there; Ubuntu has no chromium .deb, it is
   snap-only.
2. *Config.* A hand-written `openmw.cfg` aborts with `Content file specified more than once:
   builtin.omwscripts` — `resources=` already loads `resources/vfs`, which contains it, and
   `buildPeerCfg()` in `core/gamedata.ts` deliberately does not declare it. Match that shape
   rather than inventing a second config to keep in step.
3. *Account name.* `simpeer-${cellKey}` is `simpeer--2,-9`, and the account charset is
   "A-Z a-z 0-9 _ - space" — the comma is refused at register with AUTH_FAILED, the cell then
   silently has no owner, and it surfaces three minutes later as "the peer never took it".
   Sanitised in the helper. **Production is unaffected:** the supervisor keys on
   `WORLD_KEY = 'world'`.
4. *Patience.* The peer boots an entire retail game before it can take a cell — about 2.5 minutes
   on a GPU-less box, against `STEP_TIMEOUT`'s 20s. It is started before the browsers so the two
   boots overlap.

**`s43`'s soak bots also came right**: the same run reports "server reports 22 players" and
"soak bots exited 0". The wrong-port diagnosis above stands, and the port-identity guard in
`startGameServer` is what stops it recurring silently.

### Sim peer: audited for the same class, clean

The peer is a headless OpenMW running the SAME `scripts/mp`, so a client-side gap is a peer-side
gap. Checked and found sound:
- Every enforcement path that must not apply to infrastructure is behind `isSystem` — including
  both added this cycle (the movement envelope and far-travel limiting), and both lobby
  enforcement branches sit INSIDE those guards, so lobby rules cannot bite the peer.
- The peer has no character (`!char && !this.isSystem`), so lobby containment's per-character
  overlay never engages for it. Lobby mode touches character docs only, never cell state, which
  is what the peer actually writes.
- `toPlayer` is nil-safe (`if player then`), so the two new forwarders are no-ops on a headless
  peer rather than a throw inside a handler — which on the authority holder would silently
  disable a subsystem.
- The only unguarded `playerScript()` derefs are in `mp*` TEST hooks (`mpChestOpen`, the test
  hit), unreachable in normal play.

**What is NOT fixed, and is the thing to look at if it recurs:** the server still drops combat
for legitimate reasons — `cell has no authority holder` above all — and says nothing to the
attacker, who has already lost the damage locally. A cell goes dormant in `authority.ts`
(`c.holderId = null`) with **no message to the players standing in it**, so their puppets stay
attached and every attack is cancelled locally and discarded server-side until the peer
re-grants. Detaching the puppets is NOT the fix — it would have every client simulating its own
NPCs and diverging, which is the model this design deliberately left behind. Closing it properly
means either telling the client to hold its swing rather than cancel it, or acknowledging the
drop so the engine can apply the damage after all. `omwmp_combat_dropped_total{reason=...}` is
new and exists to make this visible; a rising `cell has no authority holder` is an operator
problem (a peer that crashed, wedged or never started), not a combat one.

| item | state |
| --- | --- |
| **D-cap-5** — split actor authority within a cell | **CLOSED, not deferred.** Its whole purpose was to stop one player's browser carrying a crowded cell for everyone. `worldstate.ts` now hardcodes `canSimulate` to the sim peer, so no browser ever holds a cell under any configuration — the problem it solved cannot occur. The 2026-08-24 measurement removes the other half of the case: eight players across eight anchored cells cost the peer no more than one did, so cell load is not what the peer is sized by. Do not build this without a NEW reason; the original one is gone. |
| **F3** — multi-world gateway | **BUILT** 2026-07-27. `dist/gateway.mjs` supervises world PROCESSES and serves a directory (`GET/POST /worlds`). Public worlds are always on; private/party spawn on demand and are reaped when idle. Proven with real processes: isolated rosters, `world.reaped idleMs=120030`, public untouched. Each world runs its own sim peer, so a per-session peer comes for free. |
| **F4** — cross-world ops | **BUILT 2026-08-24.** Aggregated metrics: the gateway's `/metrics` folds in every world's scrape, deduping `# HELP`/`# TYPE` so the payload stays valid, and a world that does not answer is skipped rather than failing the endpoint — worlds listen on internal ports nothing publishes, so the `world=` label metrics.ts stamps had until now been unreachable. Rolling restart: it was implemented and tested but reachable from NOWHERE (no route, no signal, no command); `SIGHUP` now runs it, guarded against overlapping rolls. Verified live: SIGHUP stopped and replaced a world while the gateway stayed healthy. Cross-world bans already worked (F1). |
| **Client lobby UI** | **BUILT.** `scripts/mp/social.lua` has a Worlds tab (list, join, create private/party), a Characters tab, and the where-am-I switcher (Solo / Party / Public, Online / Offline) that drives world moves through `mpWhere` -> `net.switchTo`. This entry said "Not built" long after it was; verified against the source 2026-08-24. |
| **Capacity governor** | **BUILT + MEASURED 2026-08-24.** `[worlds] memBudgetMb` on the gateway, taken as the lower of it and the count cap; `gateway.capacity` at boot, `capacity` on `/healthz`, `world.at_cap` names which ceiling bound it, and `GET /metrics` on the gateway. This closed a live hazard: `maxWorlds` was derived from `[server] maxPlayers` (256) on the explicit reasoning that peers were capped separately and worlds "do not multiply the peer's cost" — the opposite of the truth, since each world process runs its own `SimPeerSupervisor`. Against a 1536m container that was ~2 worlds' worth of RAM and a 256-world cap. `mem_limit` is now 8g. Sized from a real measurement (see below), not a comment. |
| **Lobby containment** | **BUILT 2026-08-24.** The gateway's public world persists nothing (`PlayerStore` lobby mode): loot, losses and position are all lobby-local, with a retain window matched to `[login] resumeWindowSec` so a reconnect is not a reset. Closes a real faucet — quest items never deplete from a container, so N strangers could each take the same Puzzle Box and keep it. The old justification ("its cells reset by construction") was false: `[cellReset] cells` is empty by default. Lobby litter is swept separately — see the row below. |
| **Engine pin** | **BUILT 2026-08-24.** `[engine] pin` makes the canonical build an operator statement rather than whoever connects first, and `refuse` mode no longer treats an absent hash as a pass — which had made it decorative against the only party it exists to stop. Still `warn` by default; production must set `enforce`+`pin` explicitly. |
| **Drop conservation** | **ENFORCEABLE, OFF BY DEFAULT.** `PlayerItemAcquired` credits acquisitions per event, closing the 2 s snapshot race that forced the previous enforcement backout. `[economy] refuseUnownedDrops` turns refusal on. It stays off until the browser scenarios have exercised every acquisition path against a real engine — the client emit is derived from the inventory scan (so complete by construction) but has NOT been run against one. |
| **F2** — 256-player ceiling | Still not measured, and it is a CLIENT question. The server-spread half now has evidence pointing the same way as the old extrapolation: eight players across eight cells cost the peer nothing over one. The wall is expected to be browser memory, which needs a wasm engine build to test at all — `wasm-build/measure-256.sh` runs it. Do not publish a player number until it has. |
| **Upstream `DelayedAction`** errors | Not ours, and now checked rather than assumed: zero occurrences anywhere in `scripts/mp/`. It is OpenMW's own menu-script machinery, present before any of this. Leave it upstream. |
| **Lobby litter** | **BUILT 2026-08-24.** `[cellReset] litterSweepSec` (default 1 h, shared lobby ONLY) wipes the cells the lobby has stored deltas for — the exact set that has accumulated anything — skipping cells with players in them. `cellReset.cells` could never cover this: it needs an explicit list, and nobody can enumerate the cells of a game the server has no data for. Safe only because the lobby persists nothing. |
| **Human playtest** | STILL OPEN, but now SCRIPTED: `PLAYTEST.md` §11 walks the eight things this cycle changed, each with what a failure looks like, so the session is spent on what nothing automated can answer. The one real question in it is whether co-op feels too easy with party scaling defaulted off. |
| **The repo's build scripts did not run on Windows at all** | **FIXED 2026-08-24.** 16 `*.sh` files and `wasm-build/patches/osg-emscripten.patch` were checked out with CRLF, so `set -euo pipefail` became `pipefail
` ("invalid option name") and the OSG patch failed every hunk against LF sources — the whole wasm dependency stack was unbuildable, and the error blamed the patch rather than the checkout. Normalised to LF, and `.gitattributes` now pins `eol=lf` on `*.sh`, `*.patch` and `*.diff` so it cannot return. Found by actually trying to build `deps/`, not by reading. |
| **`build-deps.sh` / `configure-openmw.sh` had never been run end to end** | **FIXED 2026-08-24**, by running them. Eight faults, each hiding the next — the wasm stack now builds from a clean checkout, which as far as anyone can tell it never did. Beyond the four below: (5) `build-osg.sh` staged only LIBS, never headers, so `find_package(OpenSceneGraph)` failed with every `.a` present (README already documented `deps/wasm/include` as holding OSG); (6) the `osgdb_serializers_*` targets existed only in the `|| ninja` FALLBACK, so they were skipped precisely when the explicit target list SUCCEEDED, and OpenMW then failed on `osgdb_serializers_osg=<not found>`; (7) the emsdk image ships no **pkg-config**, so FindFFmpeg located every library, read no versions, and rejected them as "too old" against an empty string; (8) the SDL2 port ships `sdl2-config.cmake` with no version file, so it reads as "unknown" and is rejected against `2.0.20` — the port is actually **2.32.10**. A `build_sdl2_cfg` target now stages a version file read from `SDL_version.h` rather than hardcoded. Original four: (1) CRLF made the OSG patch and every `.sh` unusable on a Windows checkout; (2) the pinned emsdk image has cmake but no **ninja**, which every target generates for; (3) `build_mygui` failed at "Could NOT find Freetype" because an emscripten PORT is not materialised into the sysroot until something links it — `build_em_ports` now builds the full set, which is what `Dockerfile.builder` was quietly doing instead; (4) it built target `MyGUIEngineStatic`, which does not exist — `MYGUI_STATIC=ON` changes the library TYPE, not the target NAME. Fault (3) sat directly under the function's own `### VERIFY ###` marker, which is how we know it had never executed. Plus one upstream incompatibility, not a repo bug: MyGUI 3.4.3's `UString` is `basic_string<unsigned short/int>` and modern libc++ no longer supplies `char_traits` for either — see `deps/shim/`. |
| **Peer image was unbuildable off the author's box** | **FIXED 2026-08-24.** `server/Dockerfile.simpeer` let ninja default to nproc+2 — 34 concurrent g++ on OpenMW TUs of 1-2 GB each. On a 32-core/16 GB machine that exhausts RAM, and it presents as a HANG, not an OOM: the build sat at `[652/859]` producing no output for minutes and took the Docker daemon down with it. Now `ARG BUILD_JOBS=6` / `CMAKE_BUILD_PARALLEL_LEVEL`. Budget ~1 GB per job. |

## Verified 2026-08-24

**698 tests, 698 pass, 0 fail, 0 skipped on Linux** (`node:22-bookworm`, clean `npm ci`, host
load 0.07), up from a 647-test baseline. Every behaviour changed in this cycle has
a negative control that was RUN — the guard broken deliberately and the test confirmed to fail —
rather than merely written.

The same suite on Windows reports 4 failures, and they are **environment-only, now proven so
rather than assumed**: two assert POSIX path separators in `gamedata` paths, two are SQLite
concurrent-open/write cases. All four pass on Linux. Do not treat them as a baseline to chase —
but do treat a FIFTH as real.

Also verified: every inline `<script>` in `play/index.html` and `play/launcher.html` parses
(`node --check`), and all 20 `scripts/mp/*.lua` parse as Lua 5.1 (`luaparse`). Neither check is
wired into the repo; both were run against the working tree. A Lua syntax error is otherwise
invisible until the engine loads the script and disables the whole subsystem silently, which is
the failure mode this document already warns about twice.

`wasm-build/dev-local.sh` was run end to end and comes up healthy (`testhost: listening`,
`/healthz` ok).

**The client scripts are no longer unexercised.** `./wasm-build/lua-tests/run.sh` loads the real
`net.lua`, `identity.lua` and `social.lua` against stubbed engine APIs and runs their logic:
**57 checks**, covering every disconnect code (SHUTDOWN and SERVER_FULL transient; BANNED,
KICKED, SUPERSEDED, RATE, BAD_ENGINE, BAD_CONTENT terminal), the acquisition report (seeds on
the first scan, reports gains, ignores losses, re-seeds on rejoin), the party-rule fields
`MP_PartyUpdate` must carry, and the sentence shown for every social refusal. Each is
negative-controlled and the control was RUN: emptying `TRANSIENT_DISCONNECT` fails exactly the
three restart checks, seeding `acqCounts` as `{}` instead of `nil` fails exactly the four
acquisition checks, dropping the `PartyInvite` override fails exactly the one check that says
"already in a party" means a different person on an invite than on an accept, and reverting the
handler to its own string formatting fails the wiring check — the tables can otherwise sit in
the file, correct and dead.

Two are CROSS-FILE contract tests, which is the shape that catches the bug class this cycle was
mostly about: the container-refusal test reads the reason strings out of
`server/src/core/worldstate.ts` and asserts the client words each one, so adding a refusal
server-side and forgetting the client fails a test instead of shipping. Its own negative control
earned its keep — the first version searched for the bare reason word and PASSED while the
wording was deleted, because the word also appears in a comment three lines above. It matches
the mapping entry now.

This is **not** a substitute for the browser scenarios and does not touch rendering, timing, the
engine bindings or anything the page does. It exists because a Lua mistake does not crash the
game — it makes one handler throw and silently disables a whole subsystem while the server suite
stays green, which is the failure mode this document warns about twice. The logic has now been
RUN; it has still never been run in a browser.

**A separate SEO/deploy workstream is uncommitted in the same tree** and is NOT part of the work
above: `<head>` metadata, canonical, OG/Twitter cards and JSON-LD in `play/launcher.html` and
`play/index.html`, the new `play/{og.png,robots.txt,sitemap.xml}`, and the matching rules in
`Dockerfile`, `deploy/Caddyfile` and `.github/workflows/deploy-ovh.yml`. The two sets touch the
same two HTML files but in different regions — head vs. script body — so they coexist. Both were
re-checked together: every real `<script>` block parses and the JSON-LD is valid JSON. Commit
them separately.

**The wasm engine now builds and links from a clean checkout — `deps/` is no longer the
blocker.** This was recorded here as "a missing multi-hour artifact chain, not a matter of
effort"; it was a matter of effort. The whole cross-compiled stack (OSG / Bullet / MyGUI / ICU /
Boost) and all 890 engine objects were built in the pinned `emscripten/emsdk:6.0.1` image, and
`wasm-build/link-openmw.sh` produced `openmw.wasm` (31 MB), `openmw.js` and `openmw.data`. The
eight faults that had to be fixed to get there are listed in the table above. Two link-time
faults are worth recording separately because CMake's own link cannot succeed and is not meant
to: the emscripten WebSocket library and `libosgdb_png.a` are supplied only by
`link-openmw.sh`, which is why `configure-openmw.sh` calls that script authoritative.

**What actually blocks the browser suite is a DIFFERENT artifact, and it was never written
down:** 30 of the 42 scenarios boot `?nomw`, the baked Example Suite, whose content is produced
by `content/suite-enhance/*` into the preloaded `/gamedata`. `content/` is gitignored, nothing in
the repo references `suite-enhance`, and no `.omwgame` exists anywhere in the tree — so those 30
cannot run here at any amount of effort, and they fail with the engine booting perfectly and
then `Failed loading openmw-template.omwgame: the content file does not exist`. That is the
symptom to expect; it is not an engine fault.

The remaining **11 scenarios pass `retail: true`** and boot real Morrowind data streamed from
`play/mwdata/`, which is a file the operator already has rather than a maintainer artifact:
`s40-npc`, `s41-authority-handoff`, `s42-crowded-cell`, `s43-avatar-load`, `s51-npc-combat`,
`s60-journal`, `s60b-journal-off`, `s61-dialogue-lock`, `s62-questvars`, `s63-guest-journal`,
`s98-joindiag`.

Derive that list with `grep -l 'retail:\s*true'`, not by grepping for the word — `s20-identity`
merely MENTIONS retail in a comment, boots `?nomw` like the other 30, and will always fail here
with `Failed loading openmw-template.omwgame`. It was miscounted as retail once already.

`wasm-build/Dockerfile.harness` is the Linux runner the harness header asks for — it supplies
node, python3 and a browser, and defaults `SMOKE_GL=swiftshader` because a container has no GPU.
The suite was macOS-only by hardcode before it, which is why it stopped being run.

**The 12 retail scenarios got as far as a GPU-less container can take them, and that is a real
result even though none of them passed.** With `play/mwdata/` bind-mounted from a retail install,
`s98-joindiag` boots the engine built here and it does almost everything right: Emscripten
OpenAL and Web Audio HRTF come up, it loads `Morrowind.esm`, `Tribunal.esm`, `Bloodmoon.esm` and
`mp.omwscripts`, starts the async Bullet physics thread, reserves shadow/depth/sky texture units,
enables the GLES post-processing path and the fallback water-ripple pipeline — and then, one line
after `Reserving texture unit for sky RTT`, dies with `RuntimeError: null function`.

Two hypotheses were tested and **both are wrong**, which is worth recording so nobody re-tests
them:

- *Undefined symbols tolerated at link.* The link line carries `-sERROR_ON_UNDEFINED_SYMBOLS=0`,
  and an unresolved import called at runtime raises exactly `null function`. Relinking with
  `-sERROR_ON_UNDEFINED_SYMBOLS=1` **succeeds with zero undefined symbols**, so nothing is
  missing. (The flag is still worth removing on its own merits — it can only hide this class of
  fault — but it is not the cause here.)
- *Bullet precision or exception-mode mismatch between `deps/` and the engine.* Both are built
  `-fwasm-exceptions -pthread`, and Bullet is `-DUSE_DOUBLE_PRECISION=ON` with
  `-DBT_USE_DOUBLE_PRECISION` on both sides. They agree. (`-msimd128` is in `CFLAGS_COMMON` for
  deps and absent from the engine's `CMAKE_CXX_FLAGS` — a real inconsistency, but not one that
  produces a null function pointer.)

Relinking with `--profiling-funcs` to name the frames was a **dead end and the names it produced
are not to be trusted**: it shifts the function index space, so the indices from the stripped
build's stack resolve to unrelated symbols in the named build. Naming the frames needs the stack
captured from the *same* binary that carries the names, which needs the 45 s "loading screen to
clear" wait in `launchClient` raised — a 43 MB symbol-laden wasm does not finish loading inside
it under software rasterisation.

**FOUND IT, and it was never graphics.** Naming the frames properly — same binary, with
`LOADING_CLEAR_MS` raised so a symbol-laden build has time to load — put the crash here:

```
MWGui::SettingsWindow::SettingsWindow
  -> configureWidgets (recursive)
  -> updateSliderLabel
  -> L10n::MessageBundles::formatMessage -> L10n::formatArgs
  -> icu_68::MessageFormat::format  ->  null function
```

**The emscripten ICU port has no locale data, and OpenMW dies on it during GUI construction.**
`configure-openmw.sh` sets `-DICU_DATA_LIBRARY=.../libicu_stubdata-mt.a` and
`link-openmw.sh` links that same archive. Stubdata is ICU's "the data is supplied some other
way" placeholder — and nothing was supplying it, in either script or at runtime.
Reproduced in isolation, away from OpenMW, OSG and GL entirely, with a twelve-line program
against those same three archives:

```
NumberFormat::createInstance status=U_MISSING_RESOURCE_ERROR ptr=NULL
plain ctor (no arguments)     = U_ZERO_ERROR      <- fine
ctor with an argument         = U_ZERO_ERROR      <- fine
about to format...            -> RuntimeError: null function
```

So `MessageFormat::format` asks for a `NumberFormat`, gets a null pointer, and calls a virtual
through it; in wasm a virtual call on null reads a garbage table index, which surfaces as a bare
`null function` with no message and no clue. OpenMW reaches it on EVERY boot, because
`SettingsWindow` formats a number into a slider label while building its widgets.

The port ships the data it does not link — `cache/ports/icu/icu/source/data/in/icudt68l.dat`,
ICU 68, matching the `icu_68` in the stack. Staging that into the preload package and calling
`u_setDataDirectory("/icu")` makes the same probe print `Value: 42`. The `ICU_DATA` environment
variable is NOT a substitute: this build reports an empty `u_getDataDirectory()` regardless, so
it has to be set in-process, before the first ICU use.

Fixed in `main.cpp` under `__EMSCRIPTEN__`, with `link-openmw.sh` staging the package (and
failing loudly if it is absent, rather than producing a binary that links, boots and dies).

**Two hypotheses were tested and BOTH were wrong**, recorded so nobody re-tests them:
- *Undefined symbols tolerated at link.* The link carries `-sERROR_ON_UNDEFINED_SYMBOLS=0`, and
  an unresolved import called at runtime raises exactly `null function`. Relinking with it set
  to `1` **succeeds with zero undefined symbols**. (Worth removing on its own merits — it can
  only hide this class of fault — but it was not the cause.)
- *A GL entry point SwiftShader does not implement.* Plausible: the link uses
  `libGL-getprocaddr.a`, and the engine had already logged `'glDisablei' unsupported` on that
  same boot. Killed by running the identical scenario under **ANGLE over SwiftShader** — a
  completely different GL surface — and getting a byte-identical crash at the identical line.
  Two GL implementations, one bug, therefore not GL.

Also a dead end worth not repeating: relinking with `--profiling-funcs` and reading the OLD
stack's indices against the NEW binary. It shifts the function index space, so the names come
out plausible and wrong. The stack has to come from the same binary that carries the names.

**Size, and an honest caveat:** `icudt68l.dat` is 28.5 MB, against a preload package that was
3.5 MB. That is fine for a retail boot (the game data is 817 MB) and NOT fine for the `?nomw`
demo. ICU only ever fell back to root-locale data here (`U_USING_DEFAULT_WARNING`), so a trimmed
package should be a fraction of that — `icupkg` can filter it. Shipping the full package is the
right first step to prove the engine runs; trimming it is the right second one, and it is not
done.

## Measured 2026-08-24 (Linux container, real retail data, host load 1.4)

The peer image was built and run end to end, which retired two open items at once.

| | |
| --- | --- |
| sim peer (headless OpenMW, MW+TB+BM) | **487 MB** |
| world process (node) | **136 MB** |
| **one occupied world** | **623 MB** |
| gateway process (1 world supervised) | 118 MB |
| peer spawn → `SessionHello` | **11.4 s** |

`[worlds] worldCostMb` is now **640** (rounded from 623) rather than the 780 previously assembled
from two comments — which was wrong in both halves. Verified live: an 8 GB budget reports
`{"capacity":12,"capacityReason":"memory"}` on `/healthz`, a 900 MB budget reports `capacity: 1`,
and `gateway.capacity` logs the binding ceiling at boot. `world.lobby_rules` and
`world.lobby_persistence` were both observed firing on the gateway's public world.

**Linux/displayless is no longer a question** — no `SDL_VIDEODRIVER=offscreen` or EGL/OSMesa
fallback was needed.

### Eight players, eight anchored cells — the case worldCostMb never covered

| | 1 player / 1 cell | 8 players / 8 cells |
| --- | --- | --- |
| sim peer | 487 MB | **468 MB** |
| world process | 136 MB | **135 MB** |
| total | 623 MB | **603 MB** |

Ten consecutive samples at host load 1.2–2.2, players spread across separate Seyda Neen-area
exterior cells so the peer had to anchor each one. **Anchoring eight cells costs no more than
anchoring one** — within noise, and below it here. That is the anchor-list design doing exactly
what `server.ts` claims: the ESM store and every subsystem are shared, so a marginal cell costs
that cell's data and nothing else. `[worlds] worldCostMb = 640` is therefore adequate for a
populated world, not just an idle one.

**Honest about the variance:** an earlier run of the same shape settled at 559 MB rather than
468 MB. Both were stable readings at low load, so treat ~470–560 MB as the band and 640 as the
headroom over it. What the two runs agree on is the thing that matters — the number does not
scale with occupied cells.

Still unmeasured: a cell that is busy with COMBAT rather than merely occupied, and anything
above 8 players.

### Lobby containment, proven against real containers

Not just the unit tests — the whole journey, one character, three real server processes sharing
a data dir:

1. Ordinary world: character created carrying **1 iron dagger**.
2. Shared lobby (`OMW_WORLD_ID` + public): arrives with exactly that dagger, then declares a
   much richer inventory — a Dwemer Puzzle Box and 900 gold.
3. Ordinary world again: **still just the iron dagger.**

The dagger surviving step 1 → step 3 is the control built into the journey: persistence plainly
works in ordinary worlds, and is discarded in the lobby. `world.lobby_rules` (`timeSkip=off`,
`pvp=true`, `pvpZone=wilderness`) and `world.lobby_persistence` (`writes=discarded`) were both
observed in the lobby's own log and absent from the ordinary world's.

## What is left before the gate comes off

Multiplayer is still hidden on production (`EXPERIMENTAL = ['card-mp']` in
`play/launcher.html`). Everything below is what remains; nothing else is outstanding.

1. **Finish the browser suite.** 12 of 42 have now run here (6 pass, 6 fail, all causes known).
   The remaining 30 need `content/`; four of the twelve need rewriting for the sim peer.
   Then twice consecutively on a quiet box.

   *Was:* **Run the browser suite on a machine with a GPU.**
   `node wasm-build/mp-harness.mjs`, twice consecutively, on a quiet box. This is the ONLY
   untested half: the server side is covered and the lobby/capacity behaviour is proven against
   real containers, but no browser has driven the auth ladder, the world switcher or the settle
   hold since those changed. `s57-world-revival` is new and covers the journey that put this gate
   up in the first place. Two things are needed that this machine does not have, and they are
   different in kind:
   - **`content/`** (gitignored) for the 30 `?nomw` scenarios. The maintainer has it; nothing in
     the repo can regenerate it. Without it they fail at
     `Failed loading openmw-template.omwgame`.
   - **A real GPU** for all 42. The engine builds and links here and gets most of the way through
     a retail boot in a container, then hits `RuntimeError: null function` in software
     rasterisation — see "Verified" above for the two hypotheses already ruled out and the one
     still standing.
   The wasm engine itself is no longer a blocker: it builds from a clean checkout.
2. **A human playtest** per `PLAYTEST.md` §11, with more than two people. Nothing automated
   answers "does it feel right", and party scaling defaulting OFF is a judgement that wants a
   real session behind it.
3. **Then** delete `card-mp` from `EXPERIMENTAL`.

### Known limits of the new fair-play work, stated plainly

- **The movement envelope is not a teleport check** — it bounds travel WITHIN a cell. The way
  around it (declare a `PlayerCellChange` instead of a `PlayerMove`) is now RATE-bounded rather
  than free: `[limits] farTravelPerMin` limits non-adjacent exterior jumps, which is the one
  thing the server can classify without game data (walking is always adjacent; doors go through
  an interior). That makes map-hopping useless while leaving walking and doors untouched — but a
  single unearned jump inside the budget still goes through. Closing that needs the sim peer to
  validate arrivals against the real cell graph.
- **Drop conservation covers drops, not acquisition.** The ledger proves you HELD a thing, not
  that you came by it honestly; account-level containment remains the backstop.
- **Neither is a regression** — both were true before, and both were previously undocumented.

Two things deliberately shipped OFF, to be switched on only once (1) has passed:

- `[economy] refuseUnownedDrops` — drop conservation is enforceable now, but the credit path is
  only as complete as the client reporting it, and this enforcement was backed out once before.
- `[engine] enforce` / `pin` — production should set both; the shipped default stays `warn` so a
  self-hoster with a mixed fleet is not locked out by an upgrade.

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

**Read the diagnostic you already printed before reaching for the easy explanation.**
`s42` failed with "puppet stream stalled ... which is a real bug" and the box was at load
139, so "it is just load" was right there and wrong. The next two lines of its OWN output
said `isHolder=false,true` — the "stalled" client had been PROMOTED to holder by fitness
re-election and had correctly stopped receiving its own stream. Three sibling failures in
that run really were load (all passed in isolation), which is exactly what made the fourth
easy to wave through. Attribute each failure separately.

**Two task entries were found marked done that had never been built** (F3/F4, then F1's
shared store). Both were caught by reading the code rather than trusting the status, and F1's
was blocking: with multi-world worlds, a player could not log into their own private session
with the account they made in the public world. Verify a "done" claim against the source
before building on it.

**The SERVER suite is load-sensitive too, not just the browser scenarios.**
`auth.test.ts`, `admin.test.ts` and `worldtime.test.ts` fail above roughly host load 40 and
pass below ~26 — measured repeatedly, and confirmed not to be any particular change by
stashing and watching COMMITTED code fail identically. argon2id is deliberately CPU-heavy and
`test/helpers.ts` bounds waits at 20 s. Do NOT raise that timeout to make a loaded box green:
the bound exists to catch a genuine hang. Re-run when idle, exactly as for the scenarios.
A file-level abort also shifts the reported test COUNT, so an odd total (e.g. 378 vs 377) is a
symptom of this rather than a separate mystery.

**Kill orphaned harness processes before trusting a measurement.** Stopping a background
task kills the shell, not the child `node`. One harness ran for 20 hours competing with
every gate, and a good share of what was written off as "the host is busy" was that. Check
`ps -Ao command | grep '[m]p-harness'` before believing a load-related excuse.
