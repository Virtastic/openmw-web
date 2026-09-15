# Multiplayer backlog

What the async audits and harness sweeps found, in one place. One line per item; the state
column moves as the fix lands and the bake proves it. Coverage rows live in MP-COVERAGE-MAP.md;
this file is the work queue.

States: **open** (found, not started) · **fixed** (committed on the branch, no live verdict yet)
· **baking** (in a Jenkins sweep) · **done** (green in a sweep, or unit-tested where the harness
cannot reach) · **wontfix** (design decision, reason given).

Branch: `test/posture-seen`. Sweeps: Jenkins `openmw-web-dev` #89 (2026-09-15), #90 queued.

## Found by the 2026-09-14/15 audits

| # | Item | Where | State | Proof |
|---|---|---|---|---|
| 1 | Invisibility/Chameleon/Light invisible on other screens; late joiner not caught up | global.lua, playerstate.ts | baking | s156, avatarstats.test.ts |
| 2 | Dead NPCs replayed by wire key vs object id (no-op); holder never got cell record | actors.lua, worldstate.ts | baking | s157, holderhears.test.ts |
| 3 | Holder deaf to relays for far anchored cells (doors/locks/objects) | worldstate.ts | done (unit) | holderhears.test.ts |
| 4 | Scripted Lock/Unlock never travelled (activation-only watch); then own-cell-only poll | objects.lua | baking | s158 |
| 5 | Attribute damage lost on relog / not on avatar | identity.lua, avatar.lua | done | s159 PASS #89 |
| 6 | Companion dropped on the player's relog (claim keyed by session id) | worldstate.ts | done (unit) | actor.test.ts |
| 7 | Host's quest globals never reached the peer; guests/peer seeded from own doc | quests.ts | done (unit) | questpeer.test.ts |
| 8 | Enable/disable ping-pong between disagreeing engines | worldstate.ts | done (unit) | holderhears.test.ts |
| 9 | Rolling restart booted with the flipped mode | worlds.ts | done (unit) | worlds.test.ts |
| 10 | Drop then disconnect before the inventory diff: dupe | server.ts | done (unit) | provenance.test.ts |
| 11 | One character in two worlds: last-writer-wins doc | server.ts, socialstore.ts | done (unit) | onecharacteroneworld.test.ts |
| 12 | Deleted character resurrected by a stale process flush | playerstore.ts | done (unit) | staledoc.test.ts |
| 13 | Item dropped across a cell border invisible to a joiner | worldstate.ts, connection.ts | done (unit) | holderhears.test.ts |
| 14 | PlayerDeath trusted blindly while the peer reports alive | playerstate.ts | done (unit) | avatarstats.test.ts |
| 15 | Late resurrect left the engine's main menu up | luabindings.cpp | fixed | (needs a live death with a slow round-trip) |
| 16 | F5 mid-play bounced to the launcher (fresh session, not resume) | index.html | fixed | manual / s80-style |
| 17 | Resume with the token of a still-open socket fell to a page reboot | connection.ts | done (unit) | admin.test.ts |
| 18 | Merchant stock never restocked (gold only) | worldstate.ts | done (unit) | economy.test.ts |
| 19 | Spellmaker spell persisted under a local dynamic id | global.lua, identity.lua, playerstate.ts | fixed | (scenario: make a spell via the real menu, relog) |
| 20 | Invite toast repeated on every join within 2 min | social.lua | fixed | — |
| 21 | Travel fare dropped by the reach gate (sent from the destination cell) | worldstate.ts | done (unit) | economy.test.ts |
| 22 | Disposition lost on peer restart / handoff | actors.lua | fixed | (scenario: persuade, restart peer) |
| 23 | Local fall/drown damage killed the client before the peer's verdict | character.cpp, actors.cpp | baking | s147 |
| 24 | Peer avatar never drowned: OUT OF PROCESSING RANGE of a hand-started peer (harness) | harness | baking | s149 on the managed peer |
| 25 | A heal in the frame a peer report lands was erased before measurement | identity.lua | baking | s150, s146 |
| 26 | Cloud-locker page could not change world a second time (mplocker dropped) | index.html | baking | s141 (green locally) |
| 27 | Guest death seen by the host (puppet falls, gets up) | s131 | done | s131 PASS #89 |

## Open (found, not fixed)

| # | Item | Notes |
|---|---|---|
| 28 | Magnitude re-roll on the avatar (spell with a range is rolled again on the peer) | no engine API to inject a magnitude; would need a binding or a per-cast fixed record |
| 29 | "Your guests were sent home while you were away" narration for a returning host | server.ts onPlayerLeftWorld + WorldMode |
| 30 | Gateway restart with a party: revived as private, guests get 502 then not_open | design-adjacent: host flips Party again |
| 31 | Half-open socket: client has no pong watchdog | net.lua |
| 32 | Social OK notices ("Invitation sent.", "Sent home.") never mirrored to the feed | social.lua status |
| 33 | Dying inside a dialogue: lock release unverified | quests.lua |
| 34 | No harness hook opens Training/Travel/SpellCreation/Enchanting (`svc:open:<Mode>`) | player.lua |
| 35 | PvP kill: no attribution, no bounty; no scenario kills a player with PvP on | combat.ts |

## Wontfix / by design

| Item | Reason |
|---|---|
| Guests keep loot, not quests | product decision (mp-overhaul) |
| MP tile hidden on prod (`?experimental=1`) | until the human playtest |
