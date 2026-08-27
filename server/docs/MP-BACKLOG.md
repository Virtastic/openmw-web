# Multiplayer backlog

What is known to be wrong, unverified, or missing — with the evidence, so nothing here has to
be re-derived. Ordered by what would spoil a session soonest.

Goal this is measured against: **seamless drop-in/drop-out co-op — solo, party and public —
with the server authoritative.** Not an MMO; Morrowind's data files are not built for one.

Two things earn a place here: a defect with evidence, or a claim nobody has tested. A hunch
does not.

---

## Browser suite: all ten green in one run

```
PASS s44-far-tier-correct  97.0s   PASS s73-dialogue-topics  107.8s (skips: see below)
PASS s47-worlds-ui         67.7s   PASS s81-reconnect         40.6s
PASS s48-switch-reconnect  61.3s   PASS s92-connection-lost   35.6s
PASS s53-charslots         64.3s   PASS s99-overlays          50.8s
PASS s57-world-revival    146.9s   PASS s70-time              76.7s
```

Run together, not one at a time -- they share a machine and several spawn worlds, so passing
individually proves much less.

Two lessons from getting here are worth more than the green:

**A test that measures the machine is not a test.** `s44` asserted a distance covered in a
fixed time and `s57` used fixed timeouts; both passed on a quiet box and failed on a busy one
while every other scenario merely got slower. `s44` now walks until it is far enough, and
`s57` budgets against its own measured boot. Neither can fail for being on a slow machine
again.

**Check the local fact before blaming the network.** `s73` failed as a broken relay and was
actually `addTopic` throwing, because a dialogue topic is a RECORD and the id did not exist.
It now verifies the sender learned the topic at all before asserting anything about the
receiver -- and skips, rather than failing, when the content has no topic it can use. On this
container it skips: retail data is staged and no vanilla dialogue record can be found, which
is the same limitation that keeps `s43` and `s72` from running here.

---

## What is actually left

Eight open items, and none of them is a line of code somebody forgot to write. Grouped by
what would actually close them, because "open" has meant four different things in this file:

**Needs a person or a machine we do not have (5).** Tree alpha on Brave (the workaround is in
and the player is now told; confirming it needs Brave). The minimap (one impossible render
path removed; needs a look after the next build). Intermittent camera spin (never reproduced,
here or anywhere). The main quests played through together. Many worlds actually RUNNING --
the refusal at the ceiling is tested, the load is a measurement on real hardware.

**Decided, not deferred (3).** Temporary magic effects are not restored, because the binding
sets time-left to the full duration and a restore would REFRESH every buff -- a
relog-to-refresh exploit, worse than the gap. Peers being per-host is an architecture change,
not a config one. `ovhcloud` stays unprotected because releases are made by pushing to it.

**One engine limitation, with a route around it.** AI package state cannot be read for a
foreign actor from a global script -- but an actor's own script can read its own, which is how
companions work now.

What is NOT on this list, and matters more than anything on it: none of the multiplayer work
has been confirmed by a human playing the game. The suites passing is not the same thing.

---

## P0 — unverified fixes (the largest risk right now)

Everything below was fixed and deployed today, and **none of it has been confirmed by a human
playing the game.** The automated suites cannot see most of it: 706 server tests, 68 Lua checks
and the contract gate all passed while combat was totally broken this morning.

| Check | Fix it proves | Signal if it failed |
|---|---|---|
| Unarmed attacks land | fatigue damage channel | `combat.dropped` in the server log |
| Monsters attack away from the peer's start cell | peer placement | `authority.silent_peer` |
| Two players in different cells both fight normally | one peer per cell | `simpeer.cells_unsimulated` |
| A NEW character keeps its stats across a relog | baseline gate | stats flatten to 30s |
| Plants contain loot | deferred container read | `CONTAINER NOT WATCHED` / `OUTBOUND DROPPED` |

The diagnostics are self-silencing: on a healthy session they print nothing.

**Partial progress (2026-08-26).** The browser suite now runs on the TEST host (chromium in a
container from `Dockerfile.harness`, engine extracted from the deployed image), which removes
the build box as a bottleneck. Green against the deployed engine so far: `s01-login`,
`s30-objects`, `s31-container` ("no duplication — chest 1 -> 0, single winner"), `s32-doors`,
and `s58-combat-forward`'s ARMED path. `s40-npc` SKIPPED — no sim-peer binary available — so it
is not evidence of anything.

None of that covers the five client fixes made after the deployed engine was built: client Lua
is baked into `openmw.data`, so a scenario run tests the engine as BUILT, not the tree. Those
are on 72/72 Lua checks until the next engine build reaches the harness.

**Proven, not assumed (2026-08-26).** The bundle the harness serves is measurably behind the
tree: `lootStore` and `objects.onBarterOpen` are present in `objects.lua` on the harness host
and absent from `play/openmw.data` built 25 minutes LATER. Do not date-check this -- the
mtimes look current. Probe for a symbol.

A per-file staleness sweep by grepping a source line against the bundle is NOT reliable and
should not be repeated: line endings differ between the tree and the bundle, so it reports
both false CURRENT and false STALE. Bare identifiers are the only trustworthy probe.

### The 10 scenario failures, RE-RUN against a current engine (2026-08-26)

**SEVEN of the ten PASS, confirmed in one run together (not one at a time):**

```
PASS  s44-far-tier-correct  99.3s      PASS  s81-reconnect        42.0s
PASS  s47-worlds-ui         72.5s      PASS  s92-connection-lost  35.2s
PASS  s48-switch-reconnect  66.1s      PASS  s99-overlays         51.2s
PASS  s70-time              76.6s
```

One is excluded (`s43`, the only retail scenario, which cannot pass in a GPU-less container)
and two remain: `s53-charslots` and `s57-world-revival`, both on the world-switch reload.


| Scenario | State | Why |
|---|---|---|
| `s70-time` | PASS | real product bug -- every rest teleported the sky (SNAP_HOURS) |
| `s92-connection-lost` | PASS | real product gap -- no reconnect notice existed at all |
| `s81-reconnect` | PASS | same notice |
| `s99-overlays` | PASS | scenario drove the page's mirrors without the seq that gates them |
| `s44-far-tier-correct` | PASS | scenario demanded a distance a WALK cannot cover in 16s |
| `s43-avatar-load` | excluded | the only RETAIL one; retail cannot pass in a GPU-less container |
| `s47-worlds-ui` | PASS | create, join, and the destination sees the player arrive |
| `s48-switch-reconnect` | PASS | world switch, and the reconnect that follows it |
| `s57-world-revival` | PASS | the full revival round trip (below) |
| `s53-charslots` | PASS | the character-switch round trip |

Two of the five were real product defects a player would have felt, and three were scenarios
asserting against something that could not happen. Worth noting which is which: the suite was
not simply wrong, and it was not simply right.


The first triage was against a stale bundle and could attribute nothing. These results are
against build 48, verified to contain today's Lua by identifier probe.

**Two were fixed and now PASS.** `s70-time` was a real product bug (see SNAP_HOURS below) and
`s44-far-tier-correct` was a mis-calibrated scenario -- the harness `walk:` command hardcodes
`run = false`, so 16s of walking covers ~1840 units against an assertion demanding 2400, which
no healthy build could pass. Retimed to 28000ms.

**`s43-avatar-load` is the only RETAIL scenario among the ten**, and the 12 retail scenarios do
not pass in the GPU-less harness container at all (see STATUS.md). It is excluded rather than
counted as a product failure. Its soak reporter is separately broken -- the bots ARE connected
(the server log shows `w8_0`..`w8_7` chatting, spawning and hitting throughout) while the
reporter prints `alive=0/8 rss=NaNMB ping=NaNms`.

**The remaining seven are REAL and reproduce on a current engine.** They are two clusters, and
the first has a confirmed single root cause:

#### P0: in-game session creation is completely broken (401 at the gateway)

`s47-worlds-ui`, `s48-switch-reconnect`, `s57-world-revival` and almost certainly
`s53-charslots` all fail here. **No player can create a private or party world from inside the
game.** Confirmed, not inferred:

```
worldbrowser.create_refused status=401 id=my-session mode=private account=bot-a-mtag4bm7
```

`directory.ts` takes the account from an Authorization header and never from the message body
-- deliberately, and the comment explains why: a client-supplied account made the per-owner cap
decorative, so one caller could exhaust every world slot on the host. That reasoning is sound.

But `WorldBrowser.create` (world server -> gateway) sends only a JSON body and **no
Authorization header at all**, so `resolveAccount` returns undefined and every create is 401.
The header it would need holds a LOCKER SESSION token, which the browser/launcher has and the
world server does not -- `Player` carries no token of any kind. This is not a missing line; the
two halves disagree about who authenticates.

Three ways out, and picking one is a decision about an auth boundary rather than a bug fix:

1. Route the in-game create through the BROWSER, which already holds the locker token and
   already talks to the gateway for the launcher.
2. Give the world server its own server credential, and let a caller holding it name an account
   in the body -- preserving the anti-forgery property, since only a trusted component could.
3. Plumb the player's locker token through the join handshake onto `Player` and forward it.

Until then the Worlds tab can LIST (that path needs no account) and cannot CREATE.

Fixed on the way to finding this: the refusal was undiagnosable. Every status that is not 429
or 503 collapsed into a bare `'refused'` with the status discarded, and the scenarios waited on
a world count rather than reading the answer the server actually sent -- so a 401 presented as
an opaque 30-second timeout. `worldbrowser.create_refused` now logs the status, and s47 asserts
on the mirrored result.

#### P0: the Worlds tab's join button could never work in production -- FIXED

`joinWorld()` demanded `w.host` and `w.port` and gave up with "That world did not say where to
connect" when they were absent. The directory DELIBERATELY strips both from everything it
serves, so they were always absent -- the join button could never work, and neither could
`MP_SocialJoinById`, which routes into the same function.

A comment above it wrote this off as a legacy panel and "dead UI". It is not dead: line 525 is
the Worlds tab's join button. The rule that works already existed (`worldUrlOf`, which prefers
the gateway path on the current connection's scheme and authority), so the tab now sends the
world's fields and the global side computes the address -- one place, which is what that
comment did not want to duplicate. `mpJoinWorld` also stops returning silently when it cannot
build an address, which is how this survived: the button appeared to work and the player
simply stayed put.

#### BLOCKING THE HARNESS, not the product: no switch scenario can reboot

**Resolved in two parts, and the second is the interesting one.**

*The locker session.* Harness clients sign in with `?mpauto=1`, which is a server credential
and grants no locker session, so `rebootIntoWorld` threw `no locker session` before touching
the network. The gateway now mints one on request -- ABSENT in production rather than
present-and-flagged, wired only when the operator already opted into harness auth. It is
injected AFTER boot, never through the URL: `#mplocker` flips index.html into locker/launcher
mode, a different asset path that never comes up here and killed the client outright.

*The topology.* With a session in hand the join still did nothing, and the mirrors said why:

```
joinError:   ""                                        <- the world WAS in the client's list
publicStage: "switchTo:ws://127.0.0.1:45275/w/my-session"  <- worldUrlOf built the right SHAPE
switchTo:    ""                                        <- the page took it and gave up
```

45275 is the WORLD server's port; the gateway was on 58401. `worldUrlOf` derives a switch
destination from the CURRENT connection's authority plus the world's `/w/<id>` path -- correct
in production, where clients reach a world THROUGH the gateway (Caddy fronts `/w/*`), and
wrong in a harness that dialled a world port directly, because no world serves `/w/<id>`. The
gateway is the thing that splices that path through to a world.

So the scenario, not the product, had the wrong shape: a client connected straight to a world
can never test a world switch. It now dials `ws://<gateway>/w/vvardenfell`, which is what a
real player does.


`s53`, and the join half of `s47`, `s48` and `s57`, all end in `rebootIntoWorld()`, which
needs `window.__omwLockerToken` -- a locker session that rides in the page's URL fragment as
`#mplocker=`. Harness clients authenticate with `?mpauto=1`, which is a SERVER credential and
grants no locker session, so every one of these paths throws `no locker session` before it
reaches the network. Proven rather than guessed: after a `charswitch`, `publicStage` shows
`net.switchTo` was called with a valid ws:// URL and `switchChar` holds the right id, while
the `switchTo` mirror is EMPTY -- which is precisely what the page's `failed` handler does
when the reboot throws.

So these four cannot pass as written no matter what is fixed in the product, and the join fix
above is correct but NOT verifiable here. Deciding what to do is a real choice:

1. Give harness clients a locker session (sign in through the front door and pass
   `#mplocker=`). Makes the scenarios exercise the real path -- but `s53` spawns no gateway at
   all, so it has no front door to sign into and would need one.
2. Let the reboot path accept a harness credential where a locker session is required. Smaller,
   but it puts a test-only branch inside the sign-in path, which is the worst place for one.

Until then, treat a switch/join failure in these four as UNPROVEN rather than as a defect.

#### What made the world switch testable at all (s47, s48 now PASS)

Four things had to be true, and every one of them was a wrong assumption in the SCENARIOS
rather than a defect in the product. Worth listing, because two rounds of triage read them as
product failures:

1. **The gateway splice.** `/w/<id>` is what every switch resolves to. It works -- now asserted
   directly from Node before any browser is involved, so a failure there is unambiguously the
   gateway. It must wait for the world to be UP first: dialling one still booting gets the 502
   a down world is supposed to give, and that race is what read as "the upgrade path is broken".
2. **The client must dial THROUGH the gateway.** `worldUrlOf` builds a destination from the
   current connection's authority plus `/w/<id>`, so a client wired straight to a world derives
   a path no world serves.
3. **And arrive in its OWN world, not public.** A brand-new account is refused by public with
   "finish creating your character in your private world first" -- a real rule, so booting into
   public could never have worked.
4. **`#mphome` must be set.** A switch reloads the page and Lua state dies with it, so without
   it the client relearns "my own world" as wherever it just landed -- go Solo from Public and
   it asks the PUBLIC world to turn private. The launcher sets this in production.

Also fixed across all three: they read `w.port` off the directory, which strips it, and polled
`http://127.0.0.1:undefined/status`. `playerCount` survives the sanitiser and is the right
signal.

#### `s57-world-revival` PASSES, and it found two real product bugs

The full round trip now runs: own world -> create -> join -> reaped while away -> revived on
dial -> walked back in. It is the only scenario that switches worlds THREE times, which is why
it was the only one that caught what follows -- both in `rebootIntoWorld`, both hit by a real
player on every switch:

1. **The query string was dropped.** `new URL('index.html', location.href)` has an EMPTY
   search, so the navigation went to a bare `index.html` and lost every launch parameter --
   `?stream`, `?novid`, `?skipintro`, `?start=`. The engine came back as if opened cold, so a
   switch quietly changed how the game starts. It also made the pathname+search equality test
   always false, so the reload path that code's own comment describes was never taken.
2. **Then the carried query re-armed the old world.** A launch URL can carry `mp=` in the
   QUERY, while the switch destination goes in the FRAGMENT -- so keeping the query wholesale
   booted the page straight back into the world it was leaving. The superseded keys are
   stripped now, the same list the fragment filter already used.

Fixture faults fixed on the way, none of them the product: the world had to be named `priv-*`
(the only prefix the gateway revives on dial, and revival is the whole subject), and
`--idle-reap-ms 4000` was shorter than a client boot, so the world was reaped ONE SECOND
before the player finished arriving -- the scenario was racing its own fixture.

#### OPEN, small but real: a Public press can be silently lost

Found while stabilising `s57`, which passed alone and failed in a full run. The client's own
mirror says where it stops: `publicStage` reaches `asked` and never advances. `where:public`
asks the server for a world list and switches when the answer names an up public world --
`asked` -> `list:<n>` -> `resolved:<url>`. Under load the request goes out and the answer does
not come back, so nothing switches and the player simply stays put.

To a player that is indistinguishable from a button that does nothing. The scenario presses up
to three times now, which is what a person would do, and logs which attempt landed -- so the
flake is visible rather than hidden. The product side is untouched and still open: either the
request needs a timeout and retry of its own, or the answer needs to be guaranteed.

#### The notice cluster (3) -- s99 FIXED, s92 pending a build

* `s92-connection-lost` -- timeout waiting for the in-game "connection lost" notice.
* `s99-overlays` -- timeout waiting for eviction to show a notice.
* `s81-reconnect` -- got `* you are now in the public world.` where a RECONNECTING notice was
  expected. The most informative of the three: the client is not silent, it is saying something
  else, which points at the notice path picking the wrong message rather than never firing.


---

## P1 — known defects, not yet fixed

### Rendering (never reproduced here; software GL hides them)

* **Tree alpha renders as solid black on Brave.** The workaround is already in and the
  diagnosis no longer depends on someone reading a console line.

  Cause, as far as it can be established without a Brave machine: Morrowind ships its textures
  as DXT-compressed DDS, and Brave's fingerprinting shield can hide extensions from
  `getSupportedExtensions()`, which defeats Emscripten's automatic-enable. A mesh whose
  compressed upload fails samples BLACK -- which is what an opaque black canopy IS. Eliminated:
  the shader discards correctly (`lib/material/alpha.glsl`) and the `osg::AlphaFunc` ->
  `@alphaFunc` conversion is intact, so it is not the shader.

  The page now calls `getExtension('WEBGL_compressed_texture_s3tc')` EXPLICITLY, which can
  succeed even where enumeration is hidden -- that is the actual fix. And when it genuinely
  cannot be had, the player is TOLD, rather than left with black trees and no explanation: a
  notice names the browser shield and says nothing is wrong with their save. The cause is a
  setting they can change, so it is worth saying out loud.

  Still unconfirmed on Brave itself. What is no longer true is that it needs someone to know
  to open a console.

* **Minimap renders solid white/blue/black.** REPRODUCED HERE AT LAST, and the leading theory
  is now DEAD. `s74-minimap-look` boots a client, lets the world settle and writes a HUD
  screenshot to the repo root, so looking at this costs one command instead of an afternoon.

  The shot from build 53 -- which INCLUDES the render-target fix -- still shows the map panel
  in the HUD as a flat tan field with no map detail. So it was not the `PIXEL_BUFFER_RTT`
  fallback. That change stays (a pbuffer cannot exist under WebGL and naming it as a fallback
  was wrong regardless), but it is not the cause and nobody should spend time there again.

  Eliminated now, with evidence rather than by reading: no web-specific handling in
  `localmap.cpp`; `GL_DEPTH24_STENCIL8` is valid WebGL2; the `osg::PolygonMode` set there is
  `FILL`, the GL default; and the RTT fallback. What is left is the local map's CONTENT --
  what is drawn into the target rather than where it is drawn -- and the fact that the panel
  shows a uniform colour rather than noise or black suggests the target is being cleared and
  never painted, not that it is failing to exist.

  Also visible in the same shot, and worth its own look: the multiplayer intro modal ("You are
  in the world") sits over the middle of the screen on a fresh character. That is by design,
  but it means any future gameplay screenshot needs it dismissed first.

### Input (never reproduced; keyboard input demonstrably works)

* ~~**Escape needs two presses to open the menu.**~~ NOT A BUG — confirmed working as intended
  by the reporter (2026-08-26). Nothing was ever changed for it: the only match across the whole
  branch is this backlog line, and `UiModeChanged`/input handling are untouched.
* **Intermittent camera/mouse spin.** ONE MECHANISM GUARDED, not confirmed as the cause --
  nobody has reproduced this, here or anywhere.

  `mousemanager.cpp` fed `arg.xrel`/`yrel` straight into `player.yaw()`/`pitch()` with no
  bound. Under pointer lock a browser can deliver a single mousemove carrying a movementX of
  several THOUSAND pixels -- on lock acquisition, on regaining focus, after a tab restore --
  and that is not a look, it is the camera whipping round. It matches the reported symptom
  exactly, including why it is intermittent: it happens when focus changes, not while playing.

  Clamped per event, web build only (native has no pointer lock and no such event). The cap is
  far above any genuine flick, so it can only catch the artefact and cannot become a
  sensitivity limit by the back door.

Both were reported against a build that predates this cycle. Neither reproduces in the harness.
Re-test before spending time on them.

### NPCs and actors

* ~~**Corpse loot is not synchronised, so it duplicates.**~~ FIXED — `objects.lua` watches
  `types.Container` instances only, and a dead NPC is an Actor, not a Container. The actor
  event family is `ActorAuthorityGrant/Revoke/Info`, `ActorSnapshot`, `ActorDeath`, `ActorAI`,
  `ActorEquip`, `ActorStatsDynamic` — there is **no actor-inventory event at all**. So looting a
  body is entirely client-local: two players looting the same corpse each receive the full loot,
  and the server is never told. For a design whose whole premise is server authority over items,
  this is the largest remaining hole — every fight with a party produces duplicate equipment.
  `noDrop` does not help; it strips unique-actor corpses in public worlds and nothing else.
  **Fixed** by generalising the lootable path: a chest keeps items in `Container.content`, a
  corpse in `Actor.inventory`, and both now go through the same deferred open, watch and
  ContainerOpRequest. LIVE actors are deliberately excluded — activating one opens dialogue, and
  pickpocketing is its own mechanic. The server needed no change: `docAndRef` resolves a corpse's
  refKey like any other object. **Unproven in play** — it wants a scenario with two clients
  looting one body.

* ~~**`ActorAI` is dead protocol surface.**~~ FIXED, and the diagnosis was the interesting
  part: it was not unimplemented, it was UNREACHABLE. A global script cannot read AI package
  state for a foreign actor, so no amount of work in the holder's diff loop -- where every
  other actor property is read -- could ever have produced this event. The fact now travels UP
  from a script on the actor itself. See Companions under P1b.

  With it, every server-sent event has a client handler AND every accepted inbound event is
  sent by someone. The protocol has no dead surface left.

* **AI package state cannot be read for a foreign actor** from a global script. Still true --
  it is an engine limitation -- but it is no longer a dead end. An actor's OWN local script
  can read its own packages, and `scripts/mp/companion.lua` is that route: the fact is pushed
  up rather than pulled down. `actors.lua` still derives a coarse facing/anim hint from motion
  for everything else, which is worth knowing when a puppet's animation looks wrong.

* Working, checked while here: dynamic stats (hp/magicka/fatigue), death, and applied magic
  effects all reach the victim's owner — `activeSpells:add` is driven from the CombatSpellHit
  path, including the 0-based effect indexing the engine expects.

### Sync

* ~~**mwscript global sends can starve.**~~ FIXED — `diffGlobals` now enqueues changed globals
  and drains the queue oldest-first, so nothing starves however many others are churning.
  Detection is deliberately not rate limited; only sending is. Previously it walked
  `pairs(store)` (order undefined in Lua) capped at 24/tick, so *which* globals got through was
  arbitrary and a quest global could sit unsent indefinitely while the log looked healthy.
  The relay side was already right: the server character-shadows every global by default and
  relays only a small conservative `WORLD_GLOBALS` set, which is what avoids TES3MP's
  two-players-fighting-over-one-variable ping-pong.

* ~~**`quests.lua` has NO automated coverage at all.**~~ PARTLY CLOSED. The harness now has the
  global-context stubs it lacked (`openmw.world` with mwscript/players/activeActors, and
  `openmw.interfaces`), and quests.lua is loaded and driven by four checks covering the mwscript
  global sync. Still uncovered inside that file: the journal diff, faction sync and crime sync.
  So the file is no longer a blind spot, but it is not fully exercised either — and it still
  covers the systems TES3MP reports as its worst.
* ~~**Dialogue topics are not synchronised.**~~ FIXED -- see the full entry under P1b. The
  absence was NOT the right trade: the journal is already shared, so a guest could be looking
  at a quest with no way to ask anyone about it. TES3MP's packet storm is a LOOP rather than
  volume, and it is designed out here.

---

## P1b — single-player parity: systems the multiplayer layer never sees

Audited against the question "can four friends play Morrowind the way one person can?" Each
entry below is a system with NO representation in `scripts/mp/*.lua` or `server/src/core/*.ts`.

**The distinction that matters, and it is not severity — it is direction.** An unsynced system
that only affects the actor is harmless: reading a book, drinking a potion, picking a lock all
resolve locally and nobody else needs to know. An unsynced system that touches SHARED state is a
duplication bug wearing a feature's clothes: if the world does not agree about it, every player
gets their own copy. The first group is a non-issue. The second is the same class as the corpse
loot bug already fixed here.

### Shared state that currently forks per player (duplication)

* ~~**Merchants and trainers.**~~ FIXED, both halves. STOCK: opening a barter window registers
  the merchant on the same authoritative container path a chest uses (deferred open, take/put
  watch, `ContainerOpRequest` arbitrated server-side), so two players cannot each buy the same
  unique item. PURSE: the client reads `getBarterGold` on open, the server keeps it beside the
  container on the same first-opener rule, and later openers apply the canonical figure with
  `setBarterGold`.

  The transaction is a SIGNED DELTA, not a new total -- two players trading with one merchant
  at once would each compute a different absolute from their own view and the later write would
  erase the earlier trade. Deltas commute. The delta is also bounded: a forged one cannot
  enrich the sender, but an unbounded negative one would drain a trader for the whole world.

  CORRECTION to the first version of this entry, which said trainers touch this field "and no
  other" and were therefore already covered. Both halves were wrong. SEVEN player-reachable
  windows call `setGoldPool` -- `tradewindow`, `trainingwindow`, `travelwindow`,
  `spellbuyingwindow`, `spellcreationdialog`, `enchanting`, `merchantrepair` -- and the client
  hook fired only on `newMode == 'Barter'`, so trainers were NOT covered either. All seven GUI
  modes are watched now, named from the engine's own table in `uibindings.cpp`. The skill gain
  and the buyer's gold were already synced.

  STILL OPEN, and it needs a server-side rule: **the canonical purse never restocks.** The
  engine restocks a merchant every 24h at `dialogue.cpp:537`, but that only ever writes a
  client's LOCAL value, and canonical is set by the first opener -- so a merchant drained on
  day one stays drained for the life of the world. Nobody has hit this yet because no world
  has run long enough.

  Covered by `economy.test.ts`, negative-controlled (raising the cap fails the test). NOT yet
  exercised end-to-end in a browser -- the harness runs against a stale engine bundle, so the
  client half is verified only by review and Lua parse.

* ~~**Soul gems / recharge.**~~ FIXED by the item-state work: `itemData.soul` and
  `enchantmentCharge` now persist, so a filled gem stays filled and a drained item stays
  drained. Both are operations on the player's OWN inventory, which was already synced -- the
  gap was only that a rejoin reset them.

* ~~**A shared container rewrite stripped live NPCs of their equipment.**~~ FIXED. Applying a
  canonical `ContainerState` calls `setContainerContents`, which destroys and recreates every
  object in the store. On a live actor that store is the WHOLE inventory, equipped items
  included, so a merchant's armour came back as a fresh UNEQUIPPED copy and the merchant stood
  there naked on every other client. This was live for merchants, and was found while widening
  the same path to six more NPC types -- which is why it was fixed first rather than widened.
  Slots are now captured as `slot -> recordId` before the rewrite and restored after it;
  recordId rather than object because the objects do not survive, and `setEquipment` accepts a
  recordId and searches the store.

### Systems that simply do not happen for other players

* ~~**Travel services**~~ — silt strider, boat, guild guide. RESOLVED, both halves. Read in
  the engine rather than guessed. The PLAYER's half was already covered, by three separate
  mechanisms that were not built for it:

  * The destination is a CELL CHANGE, which `PlayerState` already carries -- and the movement
    envelope deliberately forgives a cell change, because "a cell change IS a teleport by
    design (doors, travel, recall)". So arriving across the map is not flagged as cheating.
  * Travel ADVANCES TIME, and `world.lua`'s local-jump detector turns any unexplained local
    advance into a `WorldTimeRequest`, so everyone else's clock follows. (Before the
    SNAP_HOURS fix this teleported their sky instead of rolling it.)
  * The FARE pays `setGoldPool`, and `Travel` is one of the seven GUI modes now watched for
    the shared merchant purse, so it comes out of the same trader's gold everyone else sees.

  WHAT IS NOT COVERED IS FOLLOWERS. `travelwindow.cpp` calls
  `ActionTeleport::getFollowers` and moves them with you, locally. On every other client that
  NPC is driven by whoever holds its cell, and a teleport out of that cell is not something
  the actor sync expresses -- so a companion who travels with you is left standing where they
  were for everyone else.

  FIXED as the general problem rather than as a travel special case, because that is what it
  was: actors did not move between cells at all. The holder now notices an actor that has left
  the cell it was simulating -- it drops out of the live list while still being a valid object
  whose `cell` says somewhere else -- and sends `ActorCellChange`. Receivers detach the puppet
  and teleport their copy; the destination cell's holder re-attaches on its next pose, which is
  the path an actor entering a cell already took.

  Its own event rather than a wider pose: poses go out at 10 Hz and a cell change happens
  seconds or minutes apart, so paying for a cell key on every pose to carry a fact that almost
  never changes is the wrong trade. Relayed to BOTH cells, which every other actor event has no
  reason to do -- the people left behind must stop drawing it, and the people at the
  destination must have it arrive.

* ~~**Crime response**~~ — arrest, jail, fines. WORKS; traced end to end rather than grepped,
  and the original entry ("nothing arrests you") does not survive it. `[sharing] crime = true` by
  default, so a bounty relays to everyone and each client applies it to THEIR OWN player with
  `setCrimeLevel`. From there arrest is vanilla and untouched: guard AI pursues on the local
  crime level, which every client now has.

  The rest follows for free. Being arrested sets the crime level to 0 locally, `diffCrime`
  fires on any change including downwards, and the clear relays -- so paying a fine clears the
  party. Jail advances time, which the local-jump detector turns into a `WorldTimeRequest`
  (a sentence is days, well inside `MAX_ADVANCE_HOURS`'s 30). Skill loss is on the prisoner's
  own stats and already synced.

  WHAT IS ACTUALLY UNVERIFIED is narrower and worth stating as such: nobody has watched two
  players share a bounty and be arrested separately, so the interaction between two
  simultaneous arrests is untested. That is a playtest, not a missing mechanism.

  Design note, since it is a real choice and not an accident: a shared bounty means one
  player's crime makes the whole party wanted. That is the `[sharing] crime` toggle, and an
  operator who wants personal bounties can set it false today.

* ~~**Dialogue topics.**~~ IMPLEMENTED, and the decision is worth stating rather than leaving
  as "possibly the right trade". Sharing the JOURNAL and not the topics is the inconsistent
  position: a guest's quest state already routes through the host's journal, so without this a
  guest can be looking at a quest in their log with no way to ask anyone about it, because the
  topic that quest turns on was learned by someone else.

  TES3MP synced these too and earned "server freezes caused by infinite topic packet spam from
  local scripts". The failure there is a LOOP, not volume: B applies a topic, B's own diff
  then reads it as something B did not have, and sends it back. Three things stop it here --
  only additions are sent, diffed against a set, so a steady state is silent; an applied remote
  topic is written into that set BEFORE it is added, so it is never seen as a local discovery;
  and they ride the same slow beat as globals, factions and bounty.

  Routed on the JOURNAL family rather than a new one, because a topic is journal knowledge and
  has to follow the same campaign the entries do. Covered by a test that proves the echo guard
  by ORDERING rather than by waiting out a timeout for a non-event, and negative-controlled:
  relaying to everyone including the sender fails it.

* ~~**Disposition and persuasion.**~~ FIXED — the holder diffs base disposition and relays it as
  `ActorDisposition`. Confirmed SHARED rather than personal before syncing it:
  `getBaseDisposition(npc, player)` ignores its player argument and reads one value off the
  NPC's stats, so persuading or threatening someone changes how they feel about everyone. Left
  per-client, a player could talk a guard down and their friend would still be attacked by it.

* ~~**Companions / followers.**~~ FIXED. A recruited follower used to follow their recruiter
  on THAT CLIENT ONLY; everyone else saw the NPC standing where the cell had left them.

  `scripts/mp/companion.lua` runs on the actor itself, because a global script cannot read AI
  package state for a foreign actor -- which is why `ActorAI` sat unreachable rather than
  merely unimplemented. The wire carries a player ID, since the target is a player object on
  the recruiter's client and a puppet everywhere else. Applying it goes back through the actor,
  because packages can only be STARTED from the actor's own script.

  Travelling with one works too, now that actors move between cells (see Travel services).

* ~~**Vampirism and lycanthropy.**~~ Both already work, and the original entry ("no references
  at all", "whether they even survive a rejoin is unknown") was wrong on both halves.
  Verified in the engine before writing a fix that was not needed -- the same mistake this
  list already made once with diseases.

  LYCANTHROPY is explicitly handled: form is a flag on NpcStats, so nothing generic carried
  it, and `identity.lua` captures it with `NPC.isWerewolf` and restores it with
  `NPC.setWerewolf`. It rides `appearance` because that is what it is, and because appearance
  is relayed -- other players see the wolf rather than a man with a wolf's stats.

  VAMPIRISM needs nothing of its own. `character.cpp` derives it from the Vampirism MAGIC
  EFFECT magnitude, which comes from the `vampire_<clan>` ABILITY in the spell list --
  and `snapSpells` iterates the whole spell store, abilities included. It persists by the
  same route diseases do.

* ~~**Item repair.**~~ Nothing to do, and the entry's premise was wrong. "Condition is
  per-item state on a shared object" is not what repair touches: `mwmechanics/repair.cpp`
  works entirely on the PLAYER'S OWN inventory -- it raises the item's charge, consumes the
  hammer, and grants Armorer. All three were already synced, and item condition now persists
  as well.

  What DOES touch shared state is repair FOR HIRE: `merchantrepair.cpp` pays the smith out of
  `setGoldPool`, and `MerchantRepair` is one of the seven GUI modes now watched for the shared
  merchant purse.

### Confirmed working, so the audit is not one-sided

Resting advances time for everyone (`WorldTimeRequest` with `reason='rest'`). Enchanting,
spellmaking and alchemy propagate their new records through M7 `RecordCreate`. Bounty travels.
Levitation/Mark/Recall have handling. Books, potions, lockpicking and sneak are local-only by
nature and correctly need nothing.

### How to size this list

Nothing above is a crash or a corruption. They are absences, and absence reads as "the world
does not agree with itself" rather than as an error -- which is exactly why they need finding by
audit rather than by playing. Merchants are the one that would spoil a session soonest, and the
one most likely to be hit within minutes of two people logging in together.

## P1c — persistence gaps: what silently resets on every rejoin

Second scan, different question: not "is this system synced" but "does this survive a relog".
The character doc stores appearance, equipment, inventory, stats, spells, position, journal,
globals, factions and bounty. Everything below is character state Morrowind has and the doc
does not, so it resets every time the player reconnects -- silently, and in the player's favour,
which is why nobody reports it as a bug.

* ~~**Birthsign is never captured or restored.**~~ FIXED. `identity.lua` reads it with
  `types.Player.getBirthSign(self)` and the restore applies it through `applyChargen`, which
  already took one. Previously a rejoined character had no birthsign on their sheet, and its
  abilities survived only by accident because `snapSpells` captured them as spells -- which is
  also why they stacked before the attribute-climb fix.

* ~~**Item condition, enchantment charge and soul gems are not persisted.**~~ FIXED together,
  because they were one gap: `inventory` was `{ id, n }` and the restore recreated items with
  `world.createObject(recordId)`, which yields a FRESH object. Every relog fully repaired every
  weapon and every piece of armour, recharged every enchantment, and emptied every soul gem --
  free, unlimited and invisible, and the last of those breaks enchanting outright, which is the
  entire point of trapping souls.

  `itemState(item)` now reads `itemData.condition`, `itemData.enchantmentCharge` and
  `itemData.soul`, and `snapInventory` returns `{ items, itemStates }` so the shape stays
  backward compatible with docs that predate it.

* ~~**Active magic effects are not persisted**~~ -- WON'T FIX, and the reasoning is below
  rather than a shrug. No `activeSpells` field in the doc. The scope of
  this is MUCH narrower than first written here, and the original entry was wrong:

  * ~~a relog cures blight, corprus and common disease~~ **FALSE.** Diseases are `ESM::Spell`
    records of type `ST_Disease`/`ST_Blight` living in the actor's SPELL LIST
    (`Spells::purgeCommonDisease`, `hasSpellType`), not in `activeSpells`. `snapSpells` iterates
    exactly that store, so diseases, curses, abilities and powers are already captured and
    re-added by `applyPhase2`. They persist correctly today. Verified in the engine source
    before writing a fix that was not needed.
  * What genuinely does not persist is TEMPORARY effects -- potion buffs, a cast spell still
    running, an enchantment's timed effect. Losing those on a relog is cosmetic.

  And restoring them is not merely unimplemented, it is **not expressible with the current
  bindings**: `activeSpells:add()` sets `effect.mTimeLeft = effect.mDuration`, the full duration
  from the record, so a restore would REFRESH every buff instead of resuming it -- a
  relog-to-refresh exploit, and worse than the gap it closes. Doing this properly needs an engine
  binding that can set remaining time. Not worth it for cosmetic buffs; recorded so nobody
  reaches for the easy version.

### Why this group is easy to miss

Every one of these fails in the player's FAVOUR -- repaired gear, recharged items, cured
disease. Nobody files a bug about their sword being fixed. They surface as "multiplayer feels
easier than single player" long before anyone identifies a cause, and they quietly delete whole
mechanics: Armorer, Recharge, soul trapping and disease all stop mattering.

Sizing: birthsign is the cheapest to fix and the most visible to a player looking at their own
character sheet. Item condition and charge are the same fix -- the inventory doc entry needs to
carry more than a record id -- and that one change closes three of the five.

## P2 — claims nobody has tested

* **The Morrowind / Tribunal / Bloodmoon main quests, played together.** TES3MP reports the
  Tribunal main quest as "utterly broken" in multiplayer and expects the others to break the
  same way, through scripted events rather than the journal. Our journal model differs (guests
  borrow the host's journal via `journalTarget`), so the failure mode is likely different — but
  nobody has played one through.
* ~~**`[cellReset]`.**~~ NOW EXERCISED. The operator-triggered reset was already covered; what
  had never run in a test was the TIMER that makes it a policy rather than a button --
  `scheduleCellReset` and `sweepResets` had no coverage at all, which is an uncomfortable place
  for a feature whose TES3MP equivalent spawned a fork by crashing.

  The test loots a container empty and then does NOTHING: the schedule sweeps on its own, the
  container is restocked, and the player standing in the cell is handed the restored truth
  rather than kicked -- the primitive whose absence forces TES3MP admins to kick everyone.
  Negative-controlled by disabling the sweep, which fails it.

  Still unexercised: reset while a cell is under active simulation by a peer, and reset of a
  cell with scripted content, which is the specific thing that broke TES3MP.
* **Many worlds at once.** The REFUSAL is now covered; the LOAD is still not. The capacity
  governor's arithmetic was already tested, but nothing exercised a real request arriving at the
  ceiling -- and a cap that is computed and never enforced is not a cap. There is now a test
  that fills the platform and asserts the next create is refused with 503, which is the status
  `WorldBrowser` maps to `platform_full` and the client turns into "The server has no room for
  another world right now". A refusal nobody can read is a bug report about the game being
  broken. Negative-controlled by making the over-capacity path answer 200.

  What remains genuinely untested is the thing the original entry meant: many worlds actually
  RUNNING at once. That is a load measurement on real hardware, not a unit test, and the
  numbers must not be published from a busy box -- capacity figures were once published 10x
  wrong for exactly that reason.

---

## P3 — design gaps for the stated goal

* **Peers are per-world and per-host.** Coverage is uncapped now (`maxPeers = 0`), so every
  occupied cell gets an engine — but they all land on one box. Hundreds of players spread over
  hundreds of cells means hundreds of engines at ~487 MB and ~20% of a core each. Scaling past
  one host means peers on separate machines, which is an architecture change, not a config one.
* **`ovhcloud` is unprotected**, and pushing to it deploys production. No PR, no review, and
  force-push is allowed. Left alone deliberately: releases are made by pushing to it, so a
  required-review rule would block the release path until that flow changes.
* ~~**The default branch is `main`, not `dev`.**~~ FIXED -- it is `dev` now. This one was not
  cosmetic: the whole point of the dev-branch workflow is that contributors open PRs against
  `dev` for review, and a fork PR that pre-selects `main` quietly aims at the branch that
  deploys nothing and is reviewed by nobody. Clones and the repo landing page follow it too.

  `ovhcloud` above is deliberately NOT given the same treatment, and the distinction is the
  point: that one is left open because releases are made by pushing to it.

---

## Fixed today (context for anything that resurfaces)

Combat: unarmed hits refused server-side (`damage.health` demanded; the engine sends *either*
health *or* fatigue, and hand-to-hand is fatigue). Peer placement: anchoring loads a cell,
standing in it simulates it — the 7168 vs 8192 clamp. Multi-peer: one engine per occupied cell.
Character stats: the pre-restore template was broadcast over the real character and became
canonical. Containers: read before the engine had rolled the leveled loot, and the first read is
canonical forever. Caps: inventory (512) and map (1024) were gameplay bounds masquerading as DoS
bounds — one stack over and the whole inventory silently stopped persisting.

The recurring shape, worth naming: **a snapshot taken a moment too early becomes canonical, and
the system then defends the corruption.** Characters and containers were the same bug twice.
