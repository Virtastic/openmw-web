# Multiplayer backlog

What the async audits and harness sweeps found, in one place. One line per item; the state
column moves as the fix lands and the bake proves it. Coverage rows live in MP-COVERAGE-MAP.md;
this file is the work queue.

States: **open** (found, not started) · **fixed** (committed on the branch, no live verdict yet)
· **baking** (in a Jenkins sweep) · **done** (green in a sweep, or unit-tested where the harness
cannot reach) · **wontfix** (design decision, reason given).

Branch: `test/posture-seen`. Sweeps: Jenkins `openmw-web-dev` #89 (2026-09-15, 9/17), #90 running (14 scenarios), #91 next with s160.

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
| 36 | Magic at a puppet: only Damage/Restore H/M/F forwarded; Calm/Soultrap/Paralyze/Levitate-on-NPC applied to the local copy only | spelleffects.cpp | fixed | needs a target-spell mint hook + scenario |
| 37 | PvP swing/kill read as assault/murder by witnesses | mechanicsmanagerimp.cpp | fixed | (scenario: pvp on, hit B before a guard, bounty stays 0) |
| 38 | Guest's welcome carried its own doc's bounty; peer's guards read the world's | connection.ts, quests.ts | done (unit) | standing.test.ts |
| 39 | A drop carried record+count only: a pristine copy for the friend (free recharge) | objects.lua, worldstate.ts | fixed | s160, worldstate.test.ts |
| 40 | Equipment relayed at join before RecordsSync; made item never re-declared under its net id | connection.ts, global.lua | fixed | — |
| 41 | Sweep #89: a heal in the frame a peer report lands was erased before measurement | identity.lua | baking | s150 |
| 42 | Sweep #89: second world change on a cloud-locker page died with "no locker session" | index.html | baking | s141 |
| 43 | Sweep #89: scripted-lock poll covered the player's own cell only | objects.lua | baking | s158 |
| 61 | Half of all real jumps never reached the avatar (one-frame trigger vs every-other-frame sender) | player.lua | fixed | scenario: tap-jump 10x, avatar rises 10/10 |
| 62 | Avatar follow-teleport gave up after 3 s (cold interior load): no puppet in the room | global.lua | fixed | — |
| 63 | Actor batches for far anchored cells refused as stale epoch: frozen NPCs everywhere the peer's avatar was not | authority.ts, worldstate.ts | done (unit) | holderhears.test.ts |
| 64 | The peer drew from a player's byte/msg budgets; three busy cells got it disconnected with RATE | connection.ts | fixed | — |
| 65 | A dead companion's follow claim replayed to a restarted peer | worldstate.ts | fixed | — |
| 66 | Every terminal modal read "could not be reached (CODE detail)" | index.html | fixed | s91 DOM assert wanted |
| 67 | Joining a friend mid-chargen rebooted into a refusing door; unfinished character lost | social.ts, social.lua | fixed | scenario s161 sketch |
| 68 | In-game Exit did not say it was leaving: guests waited out the 90 s grace | mainmenu.cpp, index.html | fixed | — |
| 69 | Refused rest (timeSkip=owner) still healed the guest's local body: free full heal | m7.ts, playerstate.ts | done (unit) | avatarstats.test.ts |
| 70 | Bound items declared in the doc: relog inside the spell granted a permanent one | identity.lua | fixed | — |
| 71 | dayspassed never written: day-based timers a day late or backwards | world.lua | fixed | — |
| 72 | Weather holder spoke only on change; a guest's rolled-back rest left the wrong sky | world.lua | fixed | — |

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
| 35 | PvP kill: no attribution; no scenario kills a player with PvP on | combat.ts |
| 44 | Resist arrest: MP_OpenDialogue bypasses the dialogue lock; guard puppets never report "fights me" | global.lua, puppet.lua, quests.lua | 
| 45 | Jail: time skip is a local advanceTime, not through the server clock; skill loss/confiscation unverified | jailscreen path, world.lua |
| 46 | Pickpocket caught: victim's startCombat happens on an AI-off puppet, never reported | puppet.lua |
| 47 | Guest rest under timeSkip=owner: the clock is refused but the local heal is claimed (free full heal) | identity.lua / world.lua timeRefused |
| 48 | Guest's local advanceTime changes weather; holder re-sends only on change | world.lua tickWeather (clear lastWeatherSent every ~60 s) |
| 49 | dayspassed never written by writeLocalTime: TimeStamp goes backwards (powers/day, corpse timers, disease) | world.lua TIME_FIELDS |
| 50 | Map exploration/markers not persisted (blank map every login, solo included); custom markers not shared | identity.lua, playerstore.ts |
| 51 | Dialogue topics relayed, never persisted | quests.ts |
| 52 | Cell reset: vanilla loot never reappears on a running engine (only future joiners) | objects.lua |
| 53 | Weather region freezes when the holder goes indoors (no handoff) | weather.ts |
| 54 | Item condition: peer wholesale report can undo a fresh repair in the merge window | playerstate.ts handleAvatarItemStatesBatch |
| 55 | Enchant charge oscillates (both engines run passive recharge) | cosmetic |
| 56 | Mixed stacks (one damaged of five) collapse into one stack on relog | global.lua restore (create one object per state entry) |
| 57 | Container put/take carries no item state | objects.lua snapshotContainer, worldstate.ts |
| 58 | Bound items recorded in the inventory doc; a relog inside the window grants a permanent one | identity.lua snapInventory (skip sMagicBound*ID) |
| 59 | Summon: holder loss mid-effect leaves no local creature until recast | global.lua |
| 60 | Alchemy: identical potions brewed by two players are two records (doc bloat) | m7.ts (dedupe by content) |
| 73 | Knockdown/hit-recoil on the avatar not relayed: owner rubber-bands instead of "cannot move" | global.lua stats entry + player.lua controls override |
| 74 | Long fall: self-snap → PlayerCellChange → avatar teleported mid-air → fall height reset → free fall | player.lua jump detector vs falling |
| 75 | Peer restart mid-swim spawns the avatar at the last cell-change point; owner snapped there | connection.ts teleportPose gate |
| 76 | threat.lua is dead code (relayed CombatHit shape never matches); NPCs strobe between two attackers | combat.lua, threat.lua |
| 77 | Dialogue holder's NPC keeps wandering on the peer while talking; the other player watches it walk off | actors.lua (Wander distance 0 on lock) |
| 78 | Greeting/idle on the peer targets the parked dummy: NPCs near the park spot face nothing | actors.cpp (skip when peerRulesBody) |
| 79 | Escort claim needs no dialogue lock: any client can send any NPC walking | worldstate.ts |
| 80 | "npc"->AddItem in a dialogue result lands on the local puppet only | no relay for non-holder NPC inventory |
| 81 | Level +1 per message at 60/s reaches 255 in 4 s; attributes/skills unbounded | playerstate.ts clamp + one step per 10 s |
| 82 | Gold placement with fromInventory=false is counted, never refused (party worlds) | worldstate.ts |
| 83 | Fabricated first ContainerOpen becomes canonical (poison every container in a town) | worldstate.ts plausibility cap |
| 84 | ActorAI travel destination bounded only by MAX_ABS_COORD | worldstate.ts (±2 cells) |
| 85 | Guest can set the host's quest globals (by design of the shared journal) | quests.ts — wontfix? |
| 86 | Memory governor prices a world at 640 MB regardless of anchors/party size | worlds.ts /status anchors |
| 87 | No harness run beyond 4 browsers; soak bots never touch containers or a peer | bots/soak.ts |
| 88 | BAD_CONTENT terminal: nothing tells the player that a reload after the mod mounts is the remedy | index.html mpErrorModal |
| 89 | Launcher "friends playing now" lists party+occupied only; an online-but-solo friend is invisible | launcher.html |

## Wontfix / by design

| Item | Reason |
|---|---|
| Guests keep loot, not quests | product decision (mp-overhaul) |
| MP tile hidden on prod (`?experimental=1`) | until the human playtest |
