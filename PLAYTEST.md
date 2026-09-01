# OpenMW-Web Playtest Checklist

Goal: verify the in-browser port is 1:1 with desktop OpenMW. Work top-to-bottom; for each item
note ✅ works / ⚠️ works-with-glitch / ❌ broken + a one-line symptom (and a screenshot for visual
bugs). The engine runs; this list is about finding where *browser behavior diverges from desktop*.

Reload gets the latest build (server sends no-cache). Toggle the dev log with the **`** (backtick) key.

## 0. Boot & menu
- [ ] Loads to main menu without a fatal overlay; FPS reasonable
- [ ] Console (dev log) is quiet — only Info lines, no per-frame spam
- [ ] Options → Video: resolution list = native + 1/2, 1/3 … tiers; Apply changes render res
- [ ] Resize the browser window → render follows; a chosen % tier is preserved
- [ ] Options → all tabs open without black-screen (Detail Level / Water / Lights, trilinear, etc.)

## 1. New game / intro
- [ ] "New" → intro video plays through and auto-advances (Esc still skips)
- [ ] Character generation (name/race/class/birthsign/review) completes
- [ ] Released into the Census office; can walk, look, open the door

## 2. Core traversal & rendering
- [ ] Mouse-look is smooth; **shadows stay stable** while standing + rotating
- [ ] Distant objects do NOT pop in when rotating toward them
- [ ] Exterior: terrain, water reflections, trees, silt strider render correctly
- [ ] **Smoke/fire** (chimneys, hearths, torches) render as soft translucent, not black
- [ ] Cell transitions: exterior↔interior door loads; walking between exterior cells (no crash/hitch)
- [ ] Day/night cycle, sky, sun/moon, stars; weather (rain/ash/storm) if it triggers
- [ ] Water: swim, go underwater (underwater fog/tint), surface again

## 3. Combat & magic
- [ ] Melee: draw weapon, attack, hit an NPC/creature, take damage
- [ ] Ranged: bow/thrown, projectiles fly and hit
- [ ] Cast a spell (self + targeted); magic effects/particles render
- [ ] Spellmaking altar, enchanting, alchemy (potion brewing) windows work
- [ ] Death/respawn/reload flow

## 4. UI & inventory
- [ ] Inventory: drag-drop, equip/unequip, paper-doll updates
- [ ] Containers, corpses, looting; drop items into the world
- [ ] Barter with a merchant (buy/sell, gold updates)
- [ ] Repair, recharge, soul gems
- [ ] Spells/magic menu, active effects
- [ ] Map: local map (fog-of-war reveals), world map, map markers
- [ ] Journal & quest log; dialogue window (topics, persuasion, choices)
- [ ] Tooltips, drag-resize windows, right-click menus

## 5. Systems & scripting
- [ ] **Save**: quicksave (F5), named save, auto-save on rest
- [ ] **Load**: quickload (F9), load from menu — world/player/inventory restored
- [ ] Reload the browser tab → saved game still present (IDBFS persistence)
- [ ] **Bring-your-own on-disk saves**: pick your `Data Files` folder → save in-game → an
      `openmw-web-saves` folder with the save file appears inside it → clear browser data → reload
      and re-pick the folder → the save still loads
- [ ] Rest/wait/sleep (T), fast-forward time; sleeping in a bed
- [ ] Fast travel: silt strider, boat, Mark/Recall, Divine/Almsivi Intervention, Propylon
- [ ] Crime: steal/get caught → guards respond, bounty, pay/jail/resist
- [ ] Followers/companions path and keep up; enemy AI pursues/flees
- [ ] Levitation / water-walking / telekinesis / open-lock effects
- [ ] MWScript-driven events fire (doors, traps, quest triggers)

## 6. Audio
- [ ] Music plays and transitions (explore ↔ combat ↔ title)
- [ ] 3D positional SFX (footsteps by surface, ambient, spell/combat sounds)
- [ ] Voiced dialogue lines play
- [ ] Volume sliders in Options take effect

## 7. Input
- [ ] Keyboard rebinding (Options → Controls) persists across reload
- [ ] Mouse sensitivity / invert
- [ ] Pointer-lock mouse-look re-acquires cleanly after Esc
- [ ] Gamepad (if you have one) — movement, camera, menus, activate

## 8. Stability / performance (longer session)
- [ ] 20–30 min of play: no crash, no runaway memory (tab stays responsive)
- [ ] Big exterior views (Balmora, Vivec) hold acceptable FPS
- [ ] Console stays clean (no new error classes appearing over time)
- [ ] Tab-out / tab-back; close tab and reopen → save intact

## 9. Multiplayer (M0 — needs a human; the harness can't drive SDL keys)
- [ ] `?nomw&mp=ws://localhost:8080/ws&name=You&pass=x` (server: `cd server && npm run dev`):
      MOTD chat message appears in-game shortly after load
- [ ] T opens the chat window; click the input line (no programmatic focus API in 0.52 Lua —
      known UX gap), type, Enter sends; a second tab (different `name=`) sees it
- [ ] Without `?mp=` absolutely nothing multiplayer-related appears (boot log, content chain)
- [ ] Error paths look human: server not running → red top banner "could not reach the server";
      wrong `pass=` for an existing name → banner names the auth failure; kill the server while
      playing → in-game "connection lost — reload the page to retry" message (no banner)
- [ ] "Connected to <server> as <name>" pops shortly after the world loads

## 10. Multiplayer co-op (M1–M8 — two browsers, ideally two machines)

Everything below is covered by the automated suite (`node wasm-build/mp-harness.mjs`), so this
pass is about how it *feels*, not whether it functions. Use two tabs/windows with different
`name=`; the shared-NPC items need retail data (`play/mwdata/`) because the Example Suite demo
ships no NPC placements at all.

- [ ] You can see the other player move, run, jump — motion is smooth, not teleporting
- [ ] They look like their actual character (race/face/hair), and equipment changes show up
- [ ] Their health bar behaviour matches what's happening to them
- [ ] Drop an item; the other player can pick it up; it's gone for you. Both quit and rejoin —
      the world still agrees
- [ ] Open the same chest together and grab the same item: exactly one of you gets it, no dupe,
      and the loser's inventory snaps back rather than silently keeping a ghost copy
- [ ] Doors and locks: one opens, both see it
- [ ] Retail: NPCs walk the same patrol on both screens. Kill one — it dies for both and the
      shared kill tally agrees (this gates `GetDeadCount` quests)
- [ ] Retail: close the tab of whoever is simulating a cell — the other player takes over within
      a couple of seconds and the NPCs keep moving (NOT frozen)
- [ ] Fight something together: damage lands, it dies once, both of you get credit
- [ ] PvP is off by default — attacking each other does nothing until `[rules] pvp = true`
- [ ] Advance a quest; the other player's journal updates and they can continue it
- [ ] Talk to an NPC while the other tries the same NPC — they're told you're busy with it
- [ ] Rest: the clock advances for BOTH of you, weather agrees
- [ ] Reload your page mid-session — you rejoin in place without re-entering a password
- [ ] Latency feels acceptable on a real network (the local soak is 24 players at ~4 ms mean)

### Social hub styling and ESC → Options → Social
The hub is built from the same MWUI templates as the game's own Options screen, so it should
read as part of the game. Automation can prove the flows work and can screenshot them; only
a person can say whether it LOOKS right next to the real menus.

- [ ] Open the Social hub (F) with a real menu open behind it — do the border, transparency
      and font colour match, or does it read as a bolt-on?
- [ ] ESC → Options → **Social** exists and renders like every other settings page. Changing
      "Visible to" there takes effect immediately (check a friend's view).
- [ ] Tab bar: the active tab is legible as active. Counts update as people join and leave.
- [ ] With 20+ players online, does the Players tab stay usable, or does it need scrolling
      and/or a filter? (No scroll container exists yet — this is the check that decides
      whether one is needed.)
- [ ] Party: invite, accept, see members and their locations, leave. The leader leaving
      should hand over, not disband.
- [ ] Privacy: set `private`, and confirm a FRIEND can no longer see your location and
      cannot invite you. Set `party`, and confirm only party members can.

### Multiplayer windows (F = friends, G = admin)
`s46-ui-flow` already drives these flows headlessly and writes a screenshot at each step, so
the checks below are the ones it genuinely **cannot** make. It found three bugs a state-only
test could not see (windows that never rendered at all, `#` in a name eaten as a MyGUI colour
code, replies burying the player in screen messages) — assume it catches that class and
concentrate on judgement.

- [ ] **F and G actually open the windows.** The harness cannot inject SDL keys, so the
      automated run opens them by event. The key bindings themselves are untested.
- [ ] Neither key fires while another UI is open, or while typing in chat (T).
- [ ] Clicking a row does what the label says: `[invite]`, `[unfriend]`, `[accept]`,
      `[block]`, `[join]`.
- [ ] The text field accepts a click, then typing, then Enter. (0.52 Lua cannot focus it
      programmatically, so a click is required — is that discoverable?)
- [ ] Text is legible at your resolution and the window does not run off-screen with a long
      friends list or many players.
- [ ] Accepting an invite lands you next to your friend and the world looks right afterwards
      (no missing cell, no fall-through).

### Avatar render LOD (the part automation cannot judge)
Distant players are deliberately degraded so a crowded cell stays playable: past
`[limits] lodNearMaxAvatars` (default 12) an avatar stops walking and is repositioned in
occasional jumps, up to ~2048 units from where it really is. Frame cost is measured and
the drift is bounded by a test — **whether it looks acceptable is a human judgement, and
it is the only open question about this feature.**

- [ ] Walk with a friend at normal distance: they animate smoothly, no jumping. (They are
      inside the near cap, so any stutter here is a real bug, not LOD.)
- [ ] Watch a player across a town square, then across a full cell — expect visible
      jumping. Judge: reads as "far away and low detail", or as broken/teleporting?
- [ ] Stand in a crowd of 10+ and watch the ones at the back. The nearest 12 should look
      normal; note if the boundary between smooth and jumpy is distracting.
- [ ] Walk toward, then away from, a degraded player. Promotion to smooth and demotion
      back should not visibly snap or freeze mid-stride.
- [ ] With `[limits] renderLod = "full"`, everything is smooth but a crowd costs ~1.2 ms
      per avatar. Compare the two and say which you would ship.
- [ ] Combat with a player near the cap boundary: does hit feedback still line up with
      where they appear to be? (Degraded avatars are *drawn* up to 2048 units off.)

## 11. The 2026-08-24 overhaul — what changed, and how to break it

Everything here is server-verified and (for the client scripts) logic-tested, but **none of it
has been through a browser**. These are the specific things to try, and what a failure looks
like, so the session is spent on the parts nothing automated could answer.

### The lobby keeps nothing (the headline change)

1. In your own world, note what you are carrying.
2. Switch to **Public**. You should arrive with exactly that.
3. Loot something there, drop something you brought, kill something.
4. Switch back to **Solo**.

**Expected:** you leave with exactly what you walked in with — the looted thing does not follow
you, and the dropped thing is still yours. **Report if:** anything crossed either way. This is
proven at the server; what needs a human is whether it *reads* as intended rather than as the
game losing your loot. If it feels like a bug when it happens to you, say so — that is the
finding, and the fix is probably a message, not a rule.

### A restart should be a pause, not an ejection

With someone in-world, `docker kill --signal=HUP` the gateway (or redeploy).

**Expected:** "The server is restarting — putting you back in…", then play resumes roughly
where you left off. **Report if:** you get the fatal modal, or have to reload, or come back
somewhere unexpected. Until today this ejected everyone permanently.

### Party difficulty scaling now defaults OFF

Fight the same enemies solo and then as a group of three, with scaling off, then have the leader
turn it on and repeat.

**Expected, and this is the actual question:** does co-op feel too easy with it off? The default
was flipped on the reasoning that people come to co-op to play *together*, not to have the game
quietly made harder — but that is a judgement, and this session is the only thing that can
check it. Say which of the two you would rather have shipped.

### Dying, and the party settings panel

Die on purpose, somewhere far from Seyda Neen — deep in a Daedric ruin or up a Telvanni tower —
while at least one party member is alive somewhere else entirely. Then do it again with nobody
else in the party.

**Expected:** with a living party member, you come back beside them. Alone, you come back where
you fell. What must NOT happen is the old behaviour: every death dumped you at one fixed spot
outside Seyda Neen regardless of where you were, which for anyone playing past the first hour
ended the session. The rest of the party should also see a line saying you went down — losing a
friend silently is the thing being fixed.

While you are grouped, have the leader toggle each of the three party buttons (gold split,
rare-item rolls, enemy scaling) and watch **another player's** screen.

**Expected:** the other player's buttons change to match, immediately. The bug being fixed was
that they did not — the update carried no settings, so every client kept showing whatever it
assumed when it joined, and pressing a button looked like it did nothing. Also loot a rare item
as a group: the roll result should be announced to the party, not resolved silently.

### Attacks land (the one that was reported from a live server)

Walk into a cell with NPCs and attack immediately, before standing around — the bug depended on
attacking before the server had told your client who owned the cell. Do it in an interior and in
the open. Attack something a friend is also fighting. Attack, walk one cell over, attack again.

**Expected:** every swing produces an outcome — damage, or a miss, with the usual sound and
blood. What must NOT happen is the reported symptom: the swing passing through with *nothing at
all*, no damage and no miss.

**Test this with a WEAPON, not with magic.** Spells are a known gap, not a regression of this
fix: nothing on the client ever sends the spell-hit message, so spell damage does not reach the
victim's owner at all and the health bar flickers back. Casting at a friend or at an NPC is
expected to do nothing until that is built, and it needs an engine change rather than a script
one. Report melee and ranged results; do not spend the session on magic.

**Be aware which fix is which.** The contract mismatch fixed in `combat.lua` turned out to be
narrower than first thought and is probably NOT what you were hitting. The likelier cause is an
area with no simulator at that moment — and that one still loses the swing; what changed is that
the game now tells you instead of doing nothing. So the thing to check here is whether you ever
swing and get *no feedback at all*. A message saying the area is not being simulated is the fix
working, not the bug.

**If it still happens, the server can now say why.** `omwmp_combat_dropped_total` counts every
discarded combat event by reason, and the `combat.dropped` log line names it. `cell has no
authority holder` means the simulation peer was not covering that cell — a peer that has
crashed, restarted, or never started, which is an operator problem and not a combat one. Check
that counter before assuming the fix did not work.
### Being a guest in someone else's world

Join a friend's world, do a quest step, pick things up, go home.

**Expected:** the game TELLS you on arrival that quests here advance the host's journal and
your own is set aside; your own log is intact when you get back; the items and skills you gained
are yours. **Report if:** the notice did not appear or was not understandable, or if losing the
quest progress feels like a bug rather than a rule you were told about.

### The switcher and the loading screen

Solo → Party → Public → Solo, a few times, including once after leaving your own world idle long
enough to be reaped (two minutes).

**Expected:** one continuous loading screen per switch. **Report if:** it clears and comes back,
music starts over a black screen, you dead-end on an auth error, or a switch silently does
nothing. All four have happened before and all four are supposed to be fixed.

### Fair play, without breaking a real player

The interesting failures are FALSE POSITIVES, so play badly on purpose:

- Levitate, or use Boots of Blinding Speed, on a poor connection.
- Take doors and silt striders repeatedly.
- Recall / Divine Intervention / Almsivi a few times in a row.

**Expected:** nothing happens to you. **Report immediately if:** you are frozen in place, rubber
-banded, or other players stop seeing you move. The envelope is meant to be invisible to
everyone playing honestly, and a false positive on a bad connection is worse than a missed cheat.

## Reported from live play 2026-08-25 — OPEN, not yet reproduced here

Straight from a real session, recorded before triage so nothing is lost or quietly reinterpreted.
**None of these has been reproduced in the automated suite yet**, and the suite is green on the
paths several of them touch — so either they are outside what it covers, or the build that was
played is not the build the suite runs. **Establish which build first**: `play/openmw.wasm` here
is rebuilt from this working tree, and the deployed site may be older or newer than any of the
fixes in this cycle.

### Which build — ANSWERED 2026-08-25: the session was the deployed site, and it is a week behind

The report came from `morrowind.virtastic.app`, not from this tree. Measured, not assumed:

| | deployed | this tree |
| --- | --- | --- |
| engine stamp (`__ENGINE_VER`) | `b42a8f65c461` | `27d4fa302707` |
| engine binary date | 18 Aug 2026 | rebuilt from HEAD |
| preload entries | 712 (game data baked in) | 389 (streamed) |
| ICU data path | `/icudt68l.dat` (root) | `/icu/icudt68l.dat` |
| `mp.setPuppet` / `takeMagicHits` | **absent** | present |
| all 20 `scripts/mp/*.lua` | smaller, every one differs | this cycle's |

`index.html` is re-uploaded on each deploy and was fresh, which is why the site LOOKS current --
but it still points at the 18 Aug engine directory. The Lua binding names are the sound marker
here: they are string literals and survive stripping. `isPuppet`, `recordMagicHit` and
`u_setDataDirectory` are absent from BOTH binaries -- they inline away -- so they prove nothing
and were discarded rather than read as evidence.

So: **nothing in this cycle has ever been in front of a player.** Items below that "do not
reproduce here" were reproduced on a build without the fixes; that is the expected result, not a
contradiction. The suite being green and the session being broken are the same fact. Nothing is
re-triaged on that basis alone -- a deploy and a re-test is the only thing that settles them.

### Combat and NPCs
1, 6, 8. **Player cannot attack** / **escape must be pressed twice** / **random mouse spin.**
   **DOES NOT REPRODUCE HERE. Keyboard input works.** Two earlier versions of this entry said
   otherwise; both were wrong, and how they were wrong is worth keeping.

   `s64-real-input` drives real CDP input against a retail client and now shows:

   ```
   document keydown listener saw: ["k"]            <- page receives keys
   engine onKeyPress saw: k; I.UI.getMode()=none   <- engine delivers to scripts
   W (bound A_MoveForward): pose y:-69632 -> y:-69452.57, z:87.29 -> -20.77   <- THE PLAYER MOVED
   Escape: uiMode none -> none
   ```

   A BOUND ACTION moved the character ~180 units from a real keypress. 'j' opens the Journal and
   Escape closes it. Input is not broken in this build.

   **The two wrong readings, and why:**
   1. *"Keys reach the page but never the engine."* The only engine-side signal was an input
      ACTION (`A_Social`). That cannot distinguish "input is dead" from "that one binding did not
      fire". Adding a raw `onKeyPress` mirror disproved it immediately.
   2. *"Raw keys work but bound actions are dead."* The raw probe pressed **'j'** — which IS the
      Journal key. It opened the journal, and every subsequent key was then correctly swallowed
      by an open GUI window, which read as "bound actions are dead". Probing with a key bound to
      nothing, and asserting the UI mode is clear first, disproved that too.

   Both were confident and both were artifacts of the probe. The movement check is what settles
   it, because moving is unambiguous and unambiguously bound.

   **A narrow thing DOES reproduce, and it is worth someone's time.** The ready-weapon key does
   not change the stance while movement from the same dispatcher works. `F` is confirmed correct
   (`defaultKeyBindings[A_ToggleWeapon] = SDL_SCANCODE_F`), so the asymmetry is real.

   **Why it matters:** `bindingsmanager.cpp:221` disables a SPECIFIC channel set —
   `A_ToggleWeapon`, `A_ToggleSpell`, **`A_Use` (attack)**, `A_Journal`, quick keys — and
   movement is NOT in it. `keyboardmanager.cpp` calls it on every keypress as
   `setPlayerControlsEnabled(!consumed)`. So a state where those channels are disabled looks
   EXACTLY like the report: cannot attack, cannot ready a weapon, but walks around fine.

   **Two candidate causes were checked and BOTH are ruled out**, so nobody re-treads them:
   - *MyGUI consuming the key via keyboard navigation.* No: `KeyboardNavigation::injectKeyPress`
     consumes only arrows, Tab, Return/Enter/Space — `F` hits `default: return false` — and the
     widget fallback only returns true for a focused Button with a navigation key.
   - *`SDL_IsTextInputActive()` swallowing printable keys.* No: Escape is not printable and also
     produced no action, and W (printable) moved the player, so keys are plainly reaching the
     binder.

   So the channels are disabled by something else, or the fault is elsewhere entirely. The
   remaining suspects are `controlsDisabled()` and the control-switch layer
   (`mControlSwitch`, which chargen manipulates and which multiplayer's boot path touches). That
   is where I would look next, and it is a narrow question now rather than a hunt.

   **So this item is back with you.** Input works here; either the played build differs, or the
   fault needs conditions this scenario does not create. The scenario is permanent now and takes
   about 80 seconds, so it is cheap to re-point at a build that does show it.

2 & 3. **Some NPCs never attack or aggro** / **assassin will not fight, stuck in an attack
   animation.** **ROOT CAUSE FOUND — one cause for both, and it is architectural.**

   `mwmechanics/actors.cpp:1586` gates AI processing on distance to `getPlayer()`:

   > `const float distSqr = (playerPos - actor...getPosition()).length2();`
   > `// AI processing is only done within given distance to the player.`
   > `const bool inProcessingRange = distSqr <= actorsProcessingRange * actorsProcessingRange;`

   On a sim peer the "player" is the peer's OWN headless avatar, parked wherever `--start` put
   it and never moving — the peer is not a person walking around. The shipped
   `actors processing range` is **7168** units, and an exterior cell is **8192**. So any NPC near
   a real player who is not standing where the peer is parked gets NO AI PROCESSING AT ALL: it
   never aggros, never attacks, and anything caught mid-animation stays there. That is item 2 and
   item 3 exactly, including why it is "SOME" NPCs — the ones near the peer's anchor behave, the
   rest do not.

   Anchoring does not help: the peer anchors every occupied cell so they stay LOADED, but the AI
   gate measures from one avatar position, not from the anchor list.

   **FIXED PROPERLY, and the fix was half-written already.** A few hundred lines up in the same
   file, `adjustVisibility()` measures to the NEAREST SIM ANCHOR rather than to the player, with
   a comment spelling out the sim-peer case: "an actor stops processing only when it is far from
   ALL of them — which is what lets ONE peer simulate several parts of the world". The anchor
   list, the accessor (`World::getSimAnchorPositions`, world units, commented "mechanics wants
   world units") and the precedent were all there. Only the AI gate was still measuring from the
   avatar.

   It now applies the same nearest-anchor rule. On an ordinary client there are no anchors, so it
   is byte-for-byte the vanilla check; on a peer, an actor is processed if it is near ANY anchor,
   and anchors sit on occupied cells. The earlier workaround here — raising
   `actors processing range` to 24576 in `buildPeerSettings()` — has been REVERTED, because with
   the gate fixed the default range around each anchor is exactly right and inflating it would
   only make the peer simulate cells nobody is standing in.

   Verified: `s40-npc`, `s42-crowded-cell`, `s51-npc-combat` and `s59-spell-forward` all pass on
   the rebuilt engine. What is NOT proven here is the symptom itself — no scenario asserts that an
   NPC aggros a player unprompted, and writing one needs an NPC hostile to a puppet. The code
   defect and its fix are certain; the live behaviour wants your eyes.

4. **Texture transparency broken — alpha renders opaque, worst on trees.**
   **DOES NOT REPRODUCE on this build.** Reading settled nothing — the alpha-test machinery is
   intact and correct: `shadervisitor.cpp` captures the `ALPHAFUNC` attribute, disables the
   deprecated fixed-function test, and `lib/material/alpha.glsl` discards properly on both the
   plain and alpha-to-coverage paths. So the question was taken to a frame instead:
   `s65-render-check` boots retail at Seyda Neen and captures one.

   **The trees render with correct alpha** — sky and background clearly visible through the gaps
   in the foliage, leaf clusters with transparent edges rather than solid quads. If alpha were
   opaque this is exactly where it would be unmissable, which is why the report named trees.

   **Caveat that matters:** this frame is SwiftShader software rasterisation, and the reported
   session was on real hardware through ANGLE. Alpha-test and alpha-to-coverage are precisely the
   kind of thing that differs between backends — `@alphaToCoverage` takes a different branch in
   that shader. So this narrows it to "hardware-GL-specific, or a different build", it does not
   clear it. Re-check on a GPU box before closing.
5. **Minimap texture corruption — solid white, blue, or black.**
   **DOES NOT REPRODUCE on this build**, same capture. The HUD's map panel shows actual content,
   not a flat fill. Same software-rasterisation caveat as (4) — a render-to-texture path is, if
   anything, more backend-sensitive than alpha testing.

   One thing in the frame worth a second look on a GPU box: alongside the health/magicka/fatigue
   bars there is a small solid-black square in the HUD. It may be a placeholder that fills in
   later, or it may be the same corruption in miniature.

### UI and character data
6. **Escape must be pressed twice to open the menu.** Input/UI focus.
7. **Character sheet shows only one major skill, the rest missing.**
   **LEAD, with evidence — and it is not the skills sync.** `identity.lua` `skillIds()`
   enumerates every skill record and snapshots each, so the sync is complete. "Major skills"
   come from the character's CLASS record, not the skill list.

   The class is restored BY ID: `mp.applyChargen` takes a class string and calls
   `setPlayerClass(ESM::RefId::deserializeText(cls))` (`mwmp/luabindings.cpp`). That resolves an
   EXISTING class record. A player who built a CUSTOM class at chargen has a dynamic record —
   and multiplayer "boots as a fresh game and never loads a save" (`quests.lua` says so, which is
   why the journal is rebuilt from JournalSync every session). So the custom class record does
   not exist on the next boot, the id resolves to nothing, and the sheet has no majors to show.

   **NOW PROVEN FROM CODE, not just suspected.** `playerstate.ts:59` stores the class as a bare
   record id — `class: recordId(body.get('class')) ?? ''` — alongside race/head/hair. No majors,
   no minors, no specialisation. A PRESET class (Knight, Battlemage) is a content record that
   exists on every boot, so restoring it by id works. A CUSTOM class built at chargen is a
   dynamic record, multiplayer boots a fresh game and never loads a save, so on the next session
   that id resolves to nothing and the sheet has no majors to show.

   **Confirm in one minute:** make a character with a preset class and one with a custom class.
   If presets are fine and custom ones are broken, that is the whole of it.

   **The obvious fix is BLOCKED, and it is worth knowing why before anyone starts.** Persisting
   the class DEFINITION and rebuilding the record is the right answer, but class records are
   READ-ONLY from Lua: `mwlua/classbindings.cpp` exposes `majorSkills` and `specialization` as
   `sol::readonly_property` and provides no `createRecordDraft`, unlike NPCs, armour and spells.
   Recreating one needs an engine binding — the same class of change as the magic-damage seam.

   Two workarounds that do NOT need one:
   - Persist the definition and apply the skills directly. Skill BASES are writable
     (`NPC.stats.skills[id](self).base`, which `identity.lua` already reads), so a restored
     character could be given the right numbers even while the sheet's class panel stays wrong.
   - Map a custom class onto its nearest preset at chargen. Cheap, lossy, and honest if it is
     said out loud in the UI rather than done quietly.

### Input
8. **Intermittent random mouse movement, spinning the character or camera.** Pointer-lock delta
   handling is the usual cause of this in a browser build.

### World and interaction
9. **Looting plants: the container empties but nothing arrives in the inventory.**
   **PARTLY DIAGNOSED, and it is NOT a regression from this cycle.** A harvestable plant is a
   Container that OpenMW empties INSTANTLY on activation (`Container::canBeHarvested` ->
   `ActionHarvest`, `mwclass/container.cpp:195`), with no container window. But the Lua
   activation hook is a QUEUED engine event — `mEngineEvents.addToQueue(EngineEvents::OnActivate{...})`
   (`mwlua/luamanagerimp.hpp:89`) — so `objects.onActivate` does not run until the NEXT frame, by
   which time the plant is already empty.

   So `snapshotContainer` records an EMPTY container, `ContainerOpen` tells the server the plant
   held nothing, and the watch that would diff a disappearing item sees nothing change and never
   sends a `take`. Harvesting is therefore invisible to the server: it never learns the item
   moved. Nothing in `objects.lua` handles organic/harvestable containers as a special case, and
   the instant-harvest path has no seam the way an opened container does.

   **The local half is now NARROWED, though not closed.** Nothing on the multiplayer path takes
   an item OUT of a player's inventory except two things: the container-op undo (which runs only
   when a take was sent and REFUSED), and lobby containment in the public world. The inventory
   restore cannot be responsible — `global.lua` grants only the shortfall and "deliberately does
   NOT remove a surplus", precisely so a player holding more than the debounced doc records is
   never confiscated from.

   That leaves three candidates, in order of likelihood:
   1. **Not multiplayer at all** — the engine's own harvest, which would reproduce in
      singleplayer. Check that FIRST; it is the cheapest to rule in or out.
   2. **A refused take** — but per the paragraph above no take is normally sent for a plant, so
      this would mean the watch DID see a change. The refusal wording added this cycle makes it
      self-diagnosing: you would see "Somebody else took that first" or similar. Silence means
      this is not it.
   3. **The public lobby**, where inventory is contained by design. Worth knowing which world the
      session was in.
10. **Weather appears randomised on each load. FIXED.**
    Weather was never meant to reroll: `core/weather.ts` folds a region's last state when it goes
    dormant and hands it back to the next claimant "so weather CONTINUES across a dormancy
    instead of rerolling". The server did send it. The CLIENT threw it away.

    `world.lua`'s `MP_WorldWeather` drops any weather for a region it holds — correct, so a
    holder never applies its own echo back onto itself. But the continuity handback arrives
    immediately AFTER the grant that made this client the holder, so it is indistinguishable from
    an echo and was discarded by the one client it was meant for. The region then kept whatever
    weather that client rolled at boot; solo, that is a fresh roll every session.

    The handback is now marked `restore: true` and the guard honours it. Negative-controlled on
    BOTH halves and both controls were RUN: reverting the client guard fails the Lua check,
    and dropping the server's marker fails three server tests including "the longest-present
    occupant inherits on handoff".

**Nothing above is fixed.** They are recorded here because a playtest report is worth more than
the memory of one, and because two of them (1 and 9) touch code changed in this cycle and need a
before/after comparison rather than a guess.

## Reported from live play 2026-08-25 (second round, with screenshots) — Brave

Screenshots this time, which settled two of these on the spot.

### 11. Attributes climb, and the character sheet fills in late — ROOT-CAUSED AND FIXED

Two shots of the same level-1 Redguard Acrobat, minutes apart:

| | first | second |
| --- | --- | --- |
| Endurance | 225 | 275 |
| Personality | 205 | 255 |
| Fatigue | 365 | 415 |
| Major Skills listed | 1 (Acrobatics) | all 5 |

Not a display artifact: base fatigue is Str+Wil+Agi+End, and 60+30+50+**225**=365 and
60+30+50+**275**=415 both check out, so the engine really is holding those numbers. Two
attributes climb by +50 and the other six sit still.

**FIXED — `mechanicsmanagerimp.cpp` `buildPlayer()` seeded attributes from the wrong array.**
The reset loop read `player->mNpdt.mSkills[i]` where it must read `mNpdt.mAttributes[i]` — a
copy-paste of the skills loop directly above it. Present since the initial vendored snapshot
(`2600f5b`), not introduced by this cycle. It is masked whenever a race is selected, because the
race block re-bases all eight attributes absolutely, which is why ordinary chargen looks fine.

**ROOT-CAUSED AND FIXED — and my first explanation for it was WRONG, corrected here.**
The first write-up blamed the class `+10` loop accumulating without a race re-base. The
screenshots disprove that, so it is recorded as dead rather than quietly dropped. Decomposed
against the ACTUAL records read out of `Morrowind.esm` (not remembered):

- `RACE Redguard` male — Str 50, Int 30, Wil 30, Agi 40, Spd 40, End 50, Per 30, Luck 40
- `CLAS Acrobat` — favoured attributes **Agility and Endurance**, specialization Stealth

Agility 40→50 is the class `+10`, applied EXACTLY ONCE. So the race block ran, `mRaceSelected`
was true, and the class loop is idempotent as written. Endurance and Personality instead carry an
*identical* offset: **+175, then +225**.

Those are not arbitrary. The character's birthsign is **Lady's Favor**, and from the same file:

| spell | type | effect |
| --- | --- | --- |
| `lady's grace` | **Ability** | Fortify Endurance **25** |
| `lady's favor` | **Ability** | Fortify Personality **25** |

**175 = 7 × 25. 225 = 9 × 25.** The same two abilities applied seven times, then nine — which is
exactly why both attributes moved by an identical amount while the other six sat still. The sheet
shows `getModified()`, and `CreatureStats::setAttribute` recomputes base fatigue from the
**modified** attributes, which is why the fatigue bar tracked the inflation instead of exposing it.

**Mechanism.** The rejoin restore rebuilds a character in place, and nothing took the OLD effects
off. `Spells::clear()` and `removeSpell()` touch the spell LIST only — neither purges what those
spells already applied — and the Lua `activeSpells:remove()` throws for anything without
`Flag_Temporary`. Both Lady's spells are `type=Ability`, i.e. permanent, so a constant-effect
ability could not be removed from script AT ALL. Every rebuild layered one more copy on the last.

**Fix.** A new `mp.clearActiveSpells()` binding exposes the same primitive `buildPlayer()` already
uses one line below its own spell clear (`getActiveSpells().clear(ptr)`), and `identity.lua` calls
it during the restore — after clearing the spellbook, BEFORE re-adding. Order is the contract: the
engine re-applies each ability on its next update guarded by `isSpellActive`, so the count after a
restore is exactly one and cannot climb. Purging afterwards would strip the copy just applied.

Negative control RUN: with the purge disabled the recorded sequence is `clear,add:lady_s_grace`
with no purge and the check fails. 65/65 with it restored. Both edited translation units compile
clean under the real emscripten toolchain (`em++`, warnings pre-existing and unrelated).

**The Strength +10, chased down.** Working back from the fix, the *base* values are static across
both shots (only the modifier grows) and come out as Str 60, Agi 50, End 50, Per 30. Against
Redguard male that is **+10 on Strength and Agility** — but Acrobat favours **Agility and
Endurance**. The class `+10` pair landed on the wrong attributes, so the bases were captured while
the character was a class favouring Strength+Agility. Read out of `Morrowind.esm`, exactly two
classes qualify: **Crusader** and **Archer**.

That is the "the class is wrong too" half of the report, and it is a *consistency* bug rather than
an arithmetic one: `applyChargen` sets the class from `record.appearance.class`, and phase 2 then
writes `record.stats.attributes` over the rebuilt character as `.base`. The class bonus baked into
those saved bases is whatever class was current when they were captured, and it is never
recomputed against the class now being displayed. The two fields can disagree, and nothing checks.
Saving and restoring `.base` is itself correct — a persisted character's base IS the authority —
so the fix is to stop the two diverging, not to recompute bonuses on load.

### 12. A Redguard carrying Ancestor Guardian — FIXED, negative-controlled

A DUNMER power on a Redguard, alongside the correct Adrenaline Rush. `applyChargen` runs
`buildPlayer()`, which clears the spellbook and grants this character's race powers, birthsign
powers and autocalc spells; phase 2 then restored the saved set by **adding** it, so the two were
unioned and whatever the slot used to be survived into what it now is. The diff could not clean up
after it either — broadcasts are suppressed while `restoring`, and `last.spells` is re-seeded from
the union, so the stale power never surfaced as a removal and was cemented into the server doc.

`identity.lua` now clears before restoring, guarded so an empty saved set cannot wipe the grant
chargen just made. Negative control RUN: with the clear disabled the book comes back
`adrenaline_rush,ancestor_guardian` and two checks fail. 63/63 with it restored.

One thing this does not do: it stops the growth, it does not clean docs that are already
contaminated. Those keep whatever they were last saved with.

### 13. Alpha renders opaque black on Brave — CANDIDATE FIX SHIPPED + self-reporting diagnostic

Foliage draws as full black quads where the leaf cutout should be transparent. The shader path is
sound — `lib/material/alpha.glsl` discards correctly and `shadervisitor.cpp` converts the
`osg::AlphaFunc` into the `@alphaFunc`/`alphaRef` defines, and there is no `force shaders` knob to
be off in this version. The whole quad being drawn points at alpha never being tested, i.e. the
texture arriving without its alpha channel rather than the shader misjudging it.

Morrowind foliage is DXT-compressed, and WebGL can only accept that through
`WEBGL_compressed_texture_s3tc`. The build passes no extension flags — Emscripten auto-enables
whatever the browser exposes — and **Brave's fingerprinting protection can hide WebGL extensions**.
That would fail the compressed upload, sample black, and be specific to Brave, which matches both
the report and the fact that the software-GL harness here does not reproduce it.

**Candidate fix shipped.** `play/index.html` already explicitly calls `getExtension()` for every
extension that must be live before use — anisotropy, `EXT_color_buffer_float`, and friends — for
the documented reason that the context will not accept an extension's enums until it is fetched.
**S3TC was missing from that list.** It is now fetched alongside the others. Where the extension
was already enabled this is a no-op (`getExtension` is idempotent and returns the same object);
where Emscripten's automatic-enable was defeated, this is the fix.

**And it now reports itself.** The same block logs which compressed formats the context actually
exposes, so an affected machine says so in its own log instead of us inferring it from a
screenshot:

```
[gl] compressed texture formats: NONE -- DXT textures cannot upload and will sample BLACK
```

This is high leverage because of the deploy asymmetry measured above: `index.html` is re-uploaded
on EVERY deploy while the engine directory is content-addressed and can sit unchanged for weeks.
So this reaches players without an engine rebuild.

Still not *confirmed* as the cause — nothing here reproduces it on software GL, and the fix is
aimed at the leading hypothesis rather than at a demonstrated fault. If the log comes back naming
`WEBGL_compressed_texture_s3tc` and the canopy is still black, the hypothesis is dead and the next
suspect is the DDS alpha flag: OSG mapping DXT1 to `COMPRESSED_RGB_S3TC_DXT1` (no alpha) rather
than the `RGBA` variant, which would drop the cutout while leaving the texture otherwise correct.
The emscripten block in `imagemanager.cpp` rewrites UNCOMPRESSED BGRA/BGR only; compressed formats
pass through it untouched, so that is where such a fix would go.

### 14. `snapAppearance` can emit a record id that does not exist — FIXED at the consumer

Found while chasing the above, and it is a live crash path. `snapAppearance` fills an empty
race/head/hair/class from `NPC.records['villager_00']` and falls back to the literal string
`'none'` when that record is missing. **`villager_00` is a demo record and is in no retail data
file** — verified absent from `Morrowind.esm`, `Tribunal.esm` and `Bloodmoon.esm` — and even where
it exists it carries no `class`. So `'none'` is not a missing value; it is an invalid record id.

Every consumer of it ends in `buildPlayer()`, which resolves ids with `Store::find()` — and `find()
**throws**` when `search()` returns null (confirmed in `mwworld/store.cpp`). An unresolvable id
therefore does not degrade, it aborts the whole `MPApplyChargen` action, so everything sequenced
*after* the bad field — class, birthsign, name — silently never applies.

**The obvious fix is wrong, and was reverted after being written.** Making `orFallback` return `''`
instead of `'none'` looks cleaner and breaks something worse: the server REJECTS an appearance with
any empty `race`/`head`/`class`/`name` (`playerstate.ts handleAppearance`), and a rejected
appearance leaves `doc.appearance` unset, which withholds `playerRecord` on every join — losing the
character's inventory and position. That exact failure is already recorded in that function's own
comment: *a boot path that sent `name=""` cost a player their quest items*. The non-empty
placeholder is deliberate.

So the placeholder stays and the **consumer** declines what it cannot resolve: `applyChargen` now
looks each id up with `search()` before applying it, and logs `[mp] chargen: unknown race '…', left
as-is` instead of throwing. Compiles clean under `em++`.

The late-filling Major Skills list is the same restore settling, not a separate bug: phase 2 runs
0.5 s after chargen, so a sheet opened inside that window shows a half-built character.

## 12. The admin dashboard and mod manager

**Nothing in this section has been through a browser.** It is covered by 1013 server tests and
by direct runs against the real archives, but the wizard is behind a login no automated check
here can pass, so every screen below is unseen. Start from a clean data folder: the wizard only
runs once, and half of what follows is about the first run.

### The wizard, once, in order

- [ ] `./setup.sh` opens the dashboard; the first screen asks for an administrator account
- [ ] From this machine it does **not** ask for a setup key (it should only ask from off-network)
- [ ] Every step's Continue is disabled until answered, and says why in the greyed-out hint
- [ ] Back walks the steps in reverse without losing typed answers
- [ ] Reloading mid-wizard resumes on the same step with the same answers
- [ ] The step count matches the rail, and does not jump around as you answer

**The experimental answers.** Multiplayer, and "everyone brings their own copy" (the answer
where each player uploads their own game data here), are greyed out by default. "This server
hands out the files" and both storage answers are ordinary choices.

- [ ] Both are **visible** and greyed, not missing; each says which flag turns it on
- [ ] Clicking one does nothing (they are real `disabled` buttons)
- [ ] S3 storage is **not** greyed: it is only where blobs are kept
- [ ] Restart with `OMW_EXPERIMENTAL=multiplayer` and only multiplayer becomes selectable
- [ ] `OMW_EXPERIMENTAL=all` unlocks both
- [ ] Pick multiplayer, turn the flag back off, reload mid-wizard: the answer is dropped and
      the step asks again, rather than carrying to a save that refuses it
- [ ] A server already set up for multiplayer keeps working with the flag off. This is the one
      that must not regress: the gate is for new setups only

**Hosting.** Answer *Internal* and give a port: check the Caddyfile it writes uses that port and
the proxy reloads. Then check a nonsense port (0, blank, letters) is refused rather than
written; a bad listen directive takes the whole proxy down, dashboard included, and there would
be no way back in from the browser.

- [ ] A fresh server answers on **http**://localhost/admin with no certificate warning
- [ ] Finishing the wizard with *Public* hands you from `http://localhost/admin` to the
      https address showing the restart screen, instead of waiting forever on the http page
      whose listener the save just removed; *Internal* on port 80 stays put

**The engine warning.** In a fresh clone (no `play/openmw.wasm`), `./setup.sh` must warn that
the engine is missing and name the Releases zip and the `play/` folder. After unzipping the
release into `play/`, the game page must serve without any restart.

**Game data.** Drag the folder *above* `Data Files` (the one called Morrowind), which is what
people actually reach for. Every file should be accepted, not "skipped, that is normal".

- [ ] The checklist ticks each required file and each loose media folder as they arrive
- [ ] Music/Sound/Video are checked, not just the .esm and .bsa
- [ ] Uploading from a phone or another machine on the LAN works (this is the path that used to
      die at Node's five-minute request cap; a slow link is the interesting case)

### Tamriel Rebuilt

Choose **Tamriel Rebuilt** on the content step; a step for it appears after Data.

- [ ] The step does **not** appear for the other two content profiles
- [ ] `Tamriel Rebuilt 26.08.23.7z` is recognised by name and version, not just accepted
- [ ] Its three parts are listed with `00 Core` ticked and the other two **unticked**
      (`02 Firemoth Remover` deletes a vanilla quest island; it must never install by default)
- [ ] Installing only `00 Core` leaves a red warning naming `Tamriel_Data.esm` as a missing
      master, with the drop zone open rather than folded away
- [ ] `Tamriel_Data_26.08.7z` (885 MB, 54,369 files) uploads and installs; the warning clears
- [ ] The HD variant (2.7 GB) also uploads. This is the real timeout test
- [ ] An archive the hash table does not know says so and installs anyway, printing its hash
- [ ] Skipping the step entirely gets a warning on the Review screen, not a silent "all set"

**Expect a long silent wait on install.** A `.7z` has no random access, so the whole archive
unpacks before the chosen parts move: 196 s measured for the standard Tamriel Data, longer for
the HD one. The panel should say "Installing" the entire time. **Report if:** it looks finished,
errors, or the page appears to die.

### The mod list

Install two mods that overlap (the Morrowind Optimization Patch and Weapon Sheathing do).

- [ ] Row shows a readable name, not the raw Nexus filename with its digit tail
- [ ] Names read `Mod: 00 Core`, with a colon
- [ ] **Drag one below the other: the "replaces N" and "N overridden" badges swap sides as it
      moves**, not after saving. This was the reported bug
- [ ] The arrow buttons do the same, and keep keyboard focus
- [ ] Switching a mod off clears its badges immediately
- [ ] Details opens the overlap sentences, the plugin checkboxes and the archive name
- [ ] Dragging from *inside* an open Details modal selects text; it must not reorder the list
- [ ] Unticking one plugin keeps the mod's assets and drops only that plugin from the load order
- [ ] Remove asks you to type the name, and takes the folder with it
- [ ] Save, restart, and the order the page showed is the order `openmw.cfg` gets

### Savegames

- [ ] Accounts → a player → their saves, with sizes and dates
- [ ] Download one; it is a real file
- [ ] Upload it back; it appears, and a file over the quota is refused with a reason
- [ ] A moderator can list but not download or import; an owner can do both

### Then actually play it

- [ ] The mods you installed load: the boot log lists `[mods] <name> (N files)` for each
- [ ] No red "skipped, it needs X" lines
- [ ] Second boot is faster and re-fetches far less (chunks now persist in the Cache API).
      Watch the network panel: roughly 300 MB used to come down on every single boot
- [ ] With Tamriel Rebuilt installed, travel to the mainland and look at it. Error markers
      everywhere means the assets half is missing or unticked

## Known open (already triaged — not bugs to re-report)
- Some textures skip mipmaps (`glGenerateMipmap` warning) → slight distant shimmer — OSG fix pending
- No MSAA → jagged edges vs desktop — enhancement, deferred
- Anisotropic filtering off → textures softer at oblique angles — OSG fix pending
- Safari/iOS unsupported (needs a single-threaded build); mobile has no touch controls
- One AudioContext "gesture" console notice on first load — browser policy, harmless
