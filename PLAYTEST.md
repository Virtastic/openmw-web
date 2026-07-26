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

## Known open (already triaged — not bugs to re-report)
- Some textures skip mipmaps (`glGenerateMipmap` warning) → slight distant shimmer — OSG fix pending
- No MSAA → jagged edges vs desktop — enhancement, deferred
- Anisotropic filtering off → textures softer at oblique angles — OSG fix pending
- Safari/iOS unsupported (needs a single-threaded build); mobile has no touch controls
- One AudioContext "gesture" console notice on first load — browser policy, harmless
