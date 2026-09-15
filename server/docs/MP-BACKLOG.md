# Multiplayer backlog

What the async audits and harness sweeps found, in one place. One line per item; the state
column moves as the fix lands and the bake proves it. Coverage rows live in MP-COVERAGE-MAP.md;
this file is the work queue.

States: **open** (found, not started) · **fixed** (committed on the branch, no live verdict yet)
· **baking** (in a Jenkins sweep) · **done** (green in a sweep, or unit-tested where the harness
cannot reach) · **wontfix** (design decision, reason given).

Branch: `test/posture-seen`. Sweeps: Jenkins `openmw-web-dev` #89 (9/17), #90 (13/14; s147 open as #100), #91 running (31 scenarios).

## Found by the 2026-09-14/15 audits

| # | Item | Where | State | Proof |
|---|---|---|---|---|
| 1 | Invisibility/Chameleon/Light invisible on other screens; late joiner not caught up | global.lua, playerstate.ts | done | s156, avatarstats.test.ts (green #90) |
| 2 | Dead NPCs replayed by wire key vs object id (no-op); holder never got cell record | actors.lua, worldstate.ts | done | s157, holderhears.test.ts (green #90) |
| 3 | Holder deaf to relays for far anchored cells (doors/locks/objects) | worldstate.ts | done (unit) | holderhears.test.ts |
| 4 | Scripted Lock/Unlock never travelled (activation-only watch); then own-cell-only poll | objects.lua | done | s158 (green #90) |
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
| 24 | Peer avatar never drowned: OUT OF PROCESSING RANGE of a hand-started peer (harness) | harness | done | s149 PASS #90 (drowning cost 82 hp, both sides agree) |
| 25 | A heal in the frame a peer report lands was erased before measurement | identity.lua | done | s150, s146 (green #90) |
| 26 | Cloud-locker page could not change world a second time (mplocker dropped) | index.html | done | s141 PASS #90 |
| 27 | Guest death seen by the host (puppet falls, gets up) | s131 | done | s131 PASS #89 |
| 36 | Magic at a puppet: only Damage/Restore H/M/F forwarded; Calm/Soultrap/Paralyze/Levitate-on-NPC applied to the local copy only | spelleffects.cpp | fixed | needs a target-spell mint hook + scenario |
| 37 | PvP swing/kill read as assault/murder by witnesses | mechanicsmanagerimp.cpp | fixed | (scenario: pvp on, hit B before a guard, bounty stays 0) |
| 38 | Guest's welcome carried its own doc's bounty; peer's guards read the world's | connection.ts, quests.ts | done (unit) | standing.test.ts |
| 39 | A drop carried record+count only: a pristine copy for the friend (free recharge) | objects.lua, worldstate.ts | fixed | s160, worldstate.test.ts |
| 40 | Equipment relayed at join before RecordsSync; made item never re-declared under its net id | connection.ts, global.lua | fixed | — |
| 41 | Sweep #89: a heal in the frame a peer report lands was erased before measurement | identity.lua | done | s150 (green #90) |
| 42 | Sweep #89: second world change on a cloud-locker page died with "no locker session" | index.html | done | s141 (green #90) |
| 43 | Sweep #89: scripted-lock poll covered the player's own cell only | objects.lua | done | s158 (green #90) |
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
| 90 | Sneak-attack critical / weapon skill use / OnPCHitMe gated on attacker == getPlayer(): never the avatar | combat.cpp, npc.cpp, creature.cpp, actorutil | fixed | scenario: sneak behind an NPC, hit ≥ 4x |
| 91 | On-strike enchantment cast by the owner's dead swing AND the avatar: twice, charge drained twice | spelleffects.cpp | fixed | — |
| 92 | Peer hp-0 report gated for a non-driving (alt-tabbed) player: death never recorded, free resurrect | playerstate.ts | fixed | — |
| 93 | Container take in the last 2 s before a disconnect: debited from the container, never credited | connection.ts | fixed | — |
| 94 | Cell reset resync omitted locks and deaths | worldstate.ts | fixed | — |
| 95 | Guest never told whose world it is on a fresh page; Enter opens chat; chat key behind the reconnect banner; accept buttons twice; modal ignores Lua's sentence; toasts said (F) | global.lua, index.html, social.lua | fixed | — |
| 96 | Harness: no per-scenario ceiling (a hung scenario killed the sweep with no summary) | mp-harness.mjs | fixed | — |
| 97 | Harness: the peer's Lua errors were never scanned | mp-harness.mjs | fixed | — |
| 98 | Harness: worlds spawned on GW_PORT+200, onto other scenarios' gateway ports | _gateway.mjs, s47, s48 | fixed | — |
| 99 | Stat values unbounded, level +1 sixty times a second, a container's first open canonical however absurd | playerstate.ts, worldstate.ts | done (unit) | adversarial.test.ts |
| 116 | Arrows landed twice (owner's phantom + the peer's); knockdown not relayed (owner rubber-banded) | objects.lua, global.lua, player.lua, luabindings.cpp, playerstate.ts | fixed | avatarstats.test.ts (kd) |
| 117 | Companions lost on a world restart; memberVars persisted but never replayed | worldstate.ts, cellstore.ts, objects.lua | done (unit) | actor.test.ts, quests.test.ts |
| 118 | TR landmass installed before Tamriel Data loaded in that order: a quietly corrupt world on every engine | mods.ts | done (unit) | mods.test.ts |
| 119 | PROD: the inner Caddy stripped CF-Connecting-IP -- every player was the edge's IP (one login budget, one household, /ipban bans everyone) | deploy/Caddyfile | fixed | needs [limits] trustCloudflareIp = true in the prod config.toml + a deploy |
| 120 | Tamriel Data: 54k loose files, one blocking round trip each on first read -- multi-second freezes per new TR cell | mod-install.ts, bsa-pack.ts (pack >500 loose assets into <slug>.bsa at install) | done (unit) | bsa-pack.test.ts, mod-install.test.ts |
| 121 | Ban in world A never kicked the player from world B (ticket refused only later) | server.ts (ban poll on heartbeat) | done (unit) | admin.test.ts |
| 122 | Account delete left locker sessions/tickets behind (erased account could still play out the ticket) | persist/erase.ts, playerstore.ts erased tombstone | done (unit) | staledoc.test.ts |
| 123 | Ticket TTL (15 min) started at the SSO callback: idling on the tile screen booted with a dead ticket | launcher.html bootGame mints /auth/ticket right before navigating | done (unit) | authticket.test.ts |
| 124 | One session per ACCOUNT, not character: phone on char A and laptop on char B kicked each other | players.ts activeForChar, connection.ts | done (unit) | session.test.ts (resume-over-live still resolves by account: SessionIndex has no charId) |
| 129 | Puppet swing is always a chop, played on use RELEASE at 1.2x: the wind-up starts after the blow landed; swings shown in spell stance | puppet.lua showSwing: wind-up on press (start→min attack, held), blow + Weapon Swish on release (max attack→follow stop); spellcast self start→stop in the spell stance | fixed | lua-tests (edge check); needs a bake |
| 130 | Co-op melee is silent: the cancelled hit chain played the Health Damage / miss sound and the blood; the owner being hit gets no sound | puppet.lua onHitIntercept replays sound + I.Combat.spawnBloodEffect before `return false` (never Actor._onHit); player.lua MP_SelfStats plays Health Damage on an hp drop | fixed | red overlay left (C++ binding) |
| 131 | A friend casting shows nothing: CombatCast never sent, MP_CastFx dead | player.lua use edge in spell stance → mpCombatCast → combat.onCast → CombatCast{spellId,casterId,kind}; MP_CastFx plays the school's castSound + the effect's castStatic vfx | fixed | lua-tests (wire shape) |
| 132 | Levitate/slowfall/waterwalking not in VISIBLE_EFFECT: the observer's puppet pogos under a flying friend | global.lua VISIBLE_EFFECT | fixed | lua-tests |
| 133 | Puppet never looks up/down: peer streamed pitch=0, puppet ignored pitchChange | global.lua avatarStreamTick pitch; puppet.lua controls.pitchChange | fixed | needs a bake |
| 134 | Puppet runs at the template's Speed: a fast player's puppet lags 128 units then teleports | playerstate.ts stamps `speed` (doc attributes) on PlayerStatsDynamic; global.lua → MP_Stats.speed; puppet.lua sets attributes.speed.base | fixed | avatarstats.test.ts green; needs a bake |
| 135 | A friend's doors swing silently (World::activateDoor has no sound) | objects.lua MP_DoorState plays the record's openSound/closeSound | fixed | needs a bake |
| 136 | Degraded mode: poseFlags bit 3 = inAir on the sender, read as `use` by the puppet: every landing played a phantom chop | player.lua poseFlags bit 3 = use (inAir dropped: nothing read it); a flags change alone now triggers a pose send | fixed | lua-tests |

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
| 100 | s147 on the managed peer: avatar follow-teleported to z=1453 on release and no fall damage reported; server logged avatar_stats_gated (client sent no input for 6 s mid-ritual) -- why does a standing client stop driving? | player.lua inputTick / harness |
| 101 | Nametags: none rendered over puppets (only the crosshair tooltip); stale name after a rename | needs an OSG text node |
| 102 | Chat history lost on every world switch (page reboot); idle feed lines never fade; whisper dropdown lists friends in other worlds | index.html |
| 103 | "join" offered for every online friend incl. one in your world / solo; "Joining X..." status never clears | FriendView needs world/mode |
| 104 | Lua and JS narrate social failures with two different sentences | social.lua:438 vs index.html |
| 105 | No "invite" button in the page's social panel | index.html |
| 106 | Companions not persisted across a world restart (follow claims are memory only) | worldstate.ts followedBy → cell doc |
| 107 | memberVars (per-object MWScript locals) persisted but never replayed to joiners/peer | quests.ts, WorldCellState |
| 108 | Player and cell docs sweep on independent 45 s timers: a crash can dupe or lose a container take | playerstore/cellstore |
| 109 | Arrows land twice (owner's local miss + the peer's); missed arrows stored in the puppet copy | objects.lua onItemActive / launchProjectile gate |
| 110 | Essential-NPC message shown on the peer, never the owner | actors.cpp |
| 111 | hitn: bypasses the real swing path (combat.lua ignores non-test Hits); most kill scenarios prove the relay, not the swing | scenarios → attack:/press: |
| 112 | sethp:/rest: hooks are direct writes; no scenario exercises death-from-damage, the wait dialog, training, level-up dialog | hooks |
| 113 | Mirrors that are never cleared (hitFwd, spellFwd, castAt, doorEnter, takeOwned, chestOp) let a second wait pass instantly | scenarios: clear before waiting |
| 114 | SKIP detection by log text; a sweep of skips exits 0 | mp-harness.mjs |
| 115 | Peer clock is load-dependent (fixed dt 1/20 per tick): duration-based asserts compare two clocks | engine.cpp headless |
| 125 | /auth/link puts the session token in a query the edge logs; dead in gateway mode | routes.ts |
| 126 | ActorBatch is one uncapped message per cell per frame: a TR metropolis exterior is ~100 KB/s per client | actors.lua |
| 127 | No TR scenario in the harness; builder gamedata has no mods | harness |
| 128 | Dashboard-disabled expansion (Tribunal) refuses every browser client (page load order includes all masters present) | index.html buildLoadOrder vs gamedata.ts |
| 137 | Puppet bow: `shoot attach` runs, `shoot release` gated on mReadyToHit: the arrow may stay glued to the hand after a shot | character.cpp:1141-1145 |
| 138 | Revive is despawn+spawn: no get-up animation on the puppet | global.lua:2383 |
| 139 | Feature gaps: no chat bubbles, emotes, party marker on map/compass, friend highlight beyond the crosshair name | — |
| 140 | Paying the fine never calms the peer's guards/witnesses: recordCrimeId runs only on the owner's client; the peer only zeroes the bounty | luabindings.cpp mp.recordCrimePaid(), quests.lua:684 peer branch of MP_CrimeUpdate |
| 141 | A guest arrives with their HOME faction ranks (welcome record from own doc) and a guest's join/promotion is written to the host's doc + shared.factions, which is never sent at join: guest relogs and the rank is gone | connection.ts:1761 send sharedQuest().factions when factions shared |
| 142 | Persuasion result never reaches a player who enters the cell later; their next persuasion overwrites it (ActorDisposition relayed only on change, no per-actor catch-up on cell entry) | actors.lua:259 clear tracked.dispVal on MP_PlayerCellChange |
| 143 | Another player's body is a crime witness (canReportCrime excludes only getPlayer): a friend in the room refuses your owned bed, barks "thief", reports you if the template NPC has Alarm 100 | mechanicsmanagerimp.cpp:1222 isAvatar/isPuppet guard |
| 144 | Assault/murder of a guildmate on the peer never expels (the owner's engine never ran commitCrime) | MWMP::Crime.faction, MP_PlayerCrime expel |
| 145 | Peer NPC aggression toward an avatar is computed against the parked dummy (race/Personality/faction of the dummy, not the player) | mechanicsmanagerimp.cpp:493 getDerivedDisposition per target; apply doc.factions to the avatar |
| 146 | Theft/trespass victim reactions (startCombat, disposition drop) land on the thief's AI-off puppet copy; a Fight-70 NPC that would attack a thief just barks | generalises #46 |
| 147 | Personal-crime mode (crime=false) seeds a guest with the HOST's bounty | quests.ts:250 seedBounty from own cached doc |
| 148 | mStolenItems not persisted: after a relog stolen goods sell back to the victim and are not confiscated on arrest | needs a binding |

## Wontfix / by design

| Item | Reason |
|---|---|
| Guests keep loot, not quests | product decision (mp-overhaul) |
| MP tile hidden on prod (`?experimental=1`) | until the human playtest |
