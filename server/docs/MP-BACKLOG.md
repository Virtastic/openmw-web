# Multiplayer backlog

What is known to be wrong, unverified, or missing — with the evidence, so nothing here has to
be re-derived. Ordered by what would spoil a session soonest.

Goal this is measured against: **seamless drop-in/drop-out co-op — solo, party and public —
with the server authoritative.** Not an MMO; Morrowind's data files are not built for one.

Two things earn a place here: a defect with evidence, or a claim nobody has tested. A hunch
does not.

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

**Final tally: five of the ten now PASS, one is excluded, four remain and share one cause.**

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
| `s57-world-revival` | FAIL | reaches step 3 of 5; revival itself now works (below) |
| `s53-charslots` | FAIL | world switch (below), and it spawns no gateway at all |

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

#### `s57-world-revival`: revival WORKS, the scenario does not finish

`world.revived_on_dial` now fires, which is the mechanism this scenario exists to prove, and it
only fires for `priv-*` ids -- the old world name could never have been revived. It now gets
through: own world -> create -> join -> reaped. It fails on the NEXT step, going to Public:
the page reloads (its mirrors come back empty, so the switch did fire) and the client never
arrives, with no AUTH_FAILED anywhere and 180s of slack. It is the only scenario that switches
THREE times, so the suspicion is state that does not survive a second reload -- the locker
session is re-granted before each switch, but nothing proves the grant lands after the previous
reload rather than before it.


#### The notice cluster (3) -- s99 FIXED, s92 pending a build

* `s92-connection-lost` -- timeout waiting for the in-game "connection lost" notice.
* `s99-overlays` -- timeout waiting for eviction to show a notice.
* `s81-reconnect` -- got `* you are now in the public world.` where a RECONNECTING notice was
  expected. The most informative of the three: the client is not silent, it is saying something
  else, which points at the notice path picking the wrong message rather than never firing.


---

## P1 — known defects, not yet fixed

### Rendering (never reproduced here; software GL hides them)

* **Tree alpha renders as solid black on Brave.** Leading theory is Brave's fingerprinting
  protection hiding `WEBGL_compressed_texture_s3tc`, which would fail the DXT upload. The page
  now logs the compressed-format list at boot; one line from the affected machine settles it.
  Eliminated already: the shader discards correctly (`lib/material/alpha.glsl`) and the
  `osg::AlphaFunc` → `@alphaFunc` conversion is intact, so it is not the shader.
* **Minimap renders solid white/blue/black.** Undiagnosed. Eliminated: no web-specific handling
  in `localmap.cpp`, `GL_DEPTH24_STENCIL8` is valid WebGL2, and the `osg::PolygonMode` set there
  is `FILL` (the GL default, so inert even though `glPolygonMode` does not exist in GLES). The
  remaining suspect is the RTT path itself — the fallback is `PIXEL_BUFFER_RTT`, and pbuffers do
  not exist under WebGL, so anything that declines the FBO path has no working fallback.

### Input (never reproduced; keyboard input demonstrably works)

* ~~**Escape needs two presses to open the menu.**~~ NOT A BUG — confirmed working as intended
  by the reporter (2026-08-26). Nothing was ever changed for it: the only match across the whole
  branch is this backlog line, and `UiModeChanged`/input handling are untouched.
* **Intermittent camera/mouse spin.**

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

* **`ActorAI` is dead protocol surface — and it is now the ONLY one.** (`ActorEquip` FIXED: the holder diffs an actor's equipment and sends record ids, and the receiver hands them to puppet.lua's existing MP_Equip retry path, the same route a remote player's equipment already took.) A full
  protocol audit now backs that: all 54 server-sent events have a client handler, and on the
  inbound side every accepted event is sent by someone except these two (0 client references
  each). The social family looked dead to a naive scan and is not — `global.lua mpSocial`
  dispatches it through a whitelist, which is deliberate: "a local script must not be able to
  name an arbitrary server event". Both are in the server's relayed
  event set (`worldstate.ts`), and the client never sends or handles either. An NPC that draws a
  weapon, swaps armour or changes AI package mid-fight therefore looks different to every
  player. The server-side half already exists, so this is a client gap rather than a design one.

* **AI package state cannot be read for a foreign actor** from a global script, which is an
  engine limitation rather than an oversight — `actors.lua` derives a coarse facing/anim hint
  from motion instead and says so. Worth knowing when a puppet's animation looks wrong: the
  information to do better is not currently exposed.

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
* **Dialogue topics are not synchronised.** Open/close is (`mpDialogueClosed`), the topic list is
  not, so a topic one player unlocks does not appear for another. TES3MP synced these and got
  "server freezes caused by infinite topic packet spam from local scripts" for its trouble — so
  the absence may be the right trade, but it is currently undocumented and untested either way.

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

* **Travel services** — silt strider, boat, guild guide. No references. A player using one
  teleports themselves; whether the others see a sensible cell change or a player who vanished
  and reappeared across the map is untested. Party travel exists as its own mechanism and is
  NOT the same thing.

* **Crime response** — arrest, jail, fines. Bounty itself IS synced (`diffCrime`), so the number
  travels, but nothing arrests you, and what a guard does about another player's bounty is
  undefined. TES3MP reports this class as a real source of quest breakage.

* **Dialogue topics.** Open/close is synced (`mpDialogueClosed`); the topic list is not, so a
  topic one player unlocks does not appear for another. Possibly the right trade -- TES3MP synced
  these and earned "server freezes caused by infinite topic packet spam from local scripts" --
  but it is currently neither documented nor tested.

* ~~**Disposition and persuasion.**~~ FIXED — the holder diffs base disposition and relays it as
  `ActorDisposition`. Confirmed SHARED rather than personal before syncing it:
  `getBaseDisposition(npc, player)` ignores its player argument and reads one value off the
  NPC's stats, so persuading or threatening someone changes how they feel about everyone. Left
  per-client, a player could talk a guard down and their friend would still be attacked by it.

* **Companions / followers.** No `AiFollow` handling. A recruited companion follows whoever
  recruited them on that client only. Several main-quest and expansion arcs use companions.

* **Vampirism and lycanthropy.** No references at all. Both change the player's record, spells
  and how NPCs react. Whether they even survive a rejoin is unknown -- the restore path writes
  attributes and skills, and the vampire clock is a per-character global that Phase 4 shadows,
  so it may work by accident. Untested either way.

* **Item repair.** Every `repair` match in the codebase is `questRepair`, the admin tool -- not
  the hammer. Condition is per-item state on a shared object.

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

* **BIRTHSIGN IS NEVER CAPTURED OR RESTORED.** The engine binding already supports it --
  `applyChargen` takes a birthsign and applies it through `setPlayerBirthsign` -- but
  `snapAppearance` never reads one, the doc has no field for it, and the restore's applyChargen
  call passes race/head/hair/isMale/class/name and stops there. So a rejoined character has no
  birthsign on their sheet. The ABILITIES partly survive by accident, because snapSpells
  captures them as spells, which is also why they were stacking before the attribute-climb fix.
  The engine half is done; this is a three-field change on the client and the doc.

* **Item condition is not persisted.** `inventory` is `{ id, n }` -- record id and count, nothing
  else -- and the restore recreates items with `world.createObject(recordId)`, which yields a
  FRESH object. Every relog therefore fully repairs every weapon and every piece of armour. Free,
  unlimited, and invisible.

* **Enchantment charge is not persisted either**, for the same reason: a drained enchanted item
  comes back at full charge. Free recharge on demand, which also makes soul gems and the
  Recharge mechanic pointless.

* **Soul gems lose their souls.** `{ id, n }` cannot express which soul a gem holds, so a filled
  grand soul gem returns as an empty one. Directly breaks enchanting, which is the entire point
  of trapping souls.

* **Active magic effects are not persisted** -- no `activeSpells` field in the doc. The scope of
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
* **`[cellReset]`.** A whole TES3MP fork exists because cell-reset scripts crashed it. Ours is
  configured and unexercised.
* **Many worlds at once.** The gateway is memory-governed now (`gateway.capacity` reports which
  ceiling bound it) but has never run more than a handful of worlds simultaneously.

---

## P3 — design gaps for the stated goal

* **Peers are per-world and per-host.** Coverage is uncapped now (`maxPeers = 0`), so every
  occupied cell gets an engine — but they all land on one box. Hundreds of players spread over
  hundreds of cells means hundreds of engines at ~487 MB and ~20% of a core each. Scaling past
  one host means peers on separate machines, which is an architecture change, not a config one.
* **`ovhcloud` is unprotected**, and pushing to it deploys production. No PR, no review, and
  force-push is allowed. Left alone deliberately: releases are made by pushing to it, so a
  required-review rule would block the release path until that flow changes.
* **The default branch is `main`, not `dev`**, so fork PRs pre-select the wrong target.

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
