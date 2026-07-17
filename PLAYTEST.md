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

## Known open (already triaged — not bugs to re-report)
- Some textures skip mipmaps (`glGenerateMipmap` warning) → slight distant shimmer — OSG fix pending
- No MSAA → jagged edges vs desktop — enhancement, deferred
- Anisotropic filtering off → textures softer at oblique angles — OSG fix pending
- Safari/iOS unsupported (needs a single-threaded build); mobile has no touch controls
- One AudioContext "gesture" console notice on first load — browser policy, harmless
