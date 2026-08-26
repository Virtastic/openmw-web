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

* **Merchants — STOCK now shared, GOLD still not.** The stock half is fixed: opening a barter
  window registers the merchant on the same authoritative container path a chest uses (deferred
  open, take/put watch, ContainerOpRequest arbitrated server-side), so two players can no longer
  each buy the same unique item. What remains is the PURSE: `getBarterGold`/`setBarterGold` exist
  and are not yet synced, so a trader's gold is still per-client and each player can sell into a
  purse that never empties. Trainers share this exact gap and no other. Original entry follows.

  Historic: No reference to barter, trader stock or trader gold anywhere. A shop's
  inventory and purse are therefore per-client: two players can each buy the SAME unique item
  from the same merchant, and each sell the same loot to a purse that never depletes. This is
  the corpse-loot bug at economic scale, and it is reachable in the first ten minutes of play.
  Cost of ignoring it: the shared economy is meaningless, which undermines loot mattering at all.

* **Trainers — the SAME problem as merchants, not a separate one.** Re-checked: the skill gain
  and the buyer's gold are both on the buyer and both already synced (PlayerSkills, and gold is
  an inventory item). The only shared state training touches is the trainer's purse --
  `trainingwindow.cpp:202` does `setGoldPool(getGoldPool() + price)`. So merchants and trainers
  are one item: BARTER GOLD AND TRADER STOCK ARE NOT SHARED. Fixing that fixes both.

* ~~**Soul gems / recharge.**~~ FIXED by the item-state work: `itemData.soul` and
  `enchantmentCharge` now persist, so a filled gem stays filled and a drained item stays
  drained. Both are operations on the player's OWN inventory, which was already synced -- the
  gap was only that a rejoin reset them.

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
