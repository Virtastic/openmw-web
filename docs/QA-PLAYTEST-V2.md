# OpenMW-Web 2.0 (OpenTES3): human playtest checklist (Plane module 21)

Branch `OpenTES3` (v2). Nothing here is deployed; a playtest runs from a local build
(see CLAUDE.md "Where builds run"). Tick a box only when you saw it with your own eyes.
Record failures with the ticket id in brackets so they map straight back to Plane.

## 0. Before anyone plays

- [ ] The full harness sweep on the build you are testing is green (module 21: "Full harness sweep on the launch head", OT3-158). Attach the verdict list.
- [ ] `bash wasm-build/lua-tests/run.sh` and `cd server && npm test` are green on the same commit.
- [ ] `find fsroot/gamedata -iname 'Morrowind*' -o -iname 'Tribunal*' -o -iname 'Bloodmoon*'` prints nothing (retail data must not be baked into a build you hand to testers).
- [ ] Each tester brings their own Morrowind (+ Tribunal/Bloodmoon) install; testers upload their own ESMs. Legal sign-off on hosting game assets (OT3-157) is the owner's and is NOT assumed.

## 1. Mixed-progress party (the main playtest, OT3-159)

Use 4 testers with deliberately different progress, e.g. A = fresh level 1 (just left the Census office), B = level 5 mid "Fargoth's ring", C = level 10 with Fighters Guild started, D = level 15 mentor.

- [ ] Each tester signs in, picks or creates a character, and enters the **one shared world** (no world picker, no Solo/Party/host/guest wording anywhere) [OT3-31, 58, 61].
- [ ] A creates a party, invites B, C, D; all accept; the **party frame** shows each member's health/magicka/fatigue and "(busy)" while someone is in a menu or dialogue [OT3-106, 114, 105].
- [ ] The **compass strip** shows party members' bearing and distance and tracks when they move [OT3-120].
- [ ] **Per-character progression:** A and C talk to the same quest NPC at the same time without blocking each other; each sees only their own journal entries; finishing a stage for one does not move the other [OT3-51, 155, 56, 113].
- [ ] **Quest credit:** the party kills a mudcrab; everyone present gets kill credit and their own loot [OT3-82, 90]. A member who is not on the quest or is past the stage is paid the helper gold; D (mentor, L10+) helping A (below L5) gets the bonus, and the daily cap stops farming [OT3-91].
- [ ] **Levelled spawns** in a cell use the lowest level present (A at L1 with D at L15 in the same cell gives low-level spawns) [OT3-97, 146].
- [ ] **Rest:** A rests 8 hours; only A's clock/sky moves; B, C, D see no time jump and are not refused [OT3-108]. A levels up and regains magicka.
- [ ] **Death:** a member dies; the party can revive or the member respawns at the nearest visited shrine/temple; a second death within ~5 min returns at half stats; the death notice goes to the cell and party only, not the whole world [OT3-174, 175, 176].

## 2. Social and chat

- [ ] Chat channels: say (proximity), world, party, global (rate-limited), whisper to any online player, Novice channel for new characters and opted-in mentors [OT3-110, 134, 67]. No `!`/`@` prefix does anything special; a leading `!` in a `say` line is just text [OT3-129].
- [ ] Chat filter masks listed words/links on public channels; a timed mute works [OT3-185].
- [ ] `/me` and canned emotes (`/wave`, `/bow`) show only to players in range [OT3-103].
- [ ] Nameplates show faction titles and can be toggled in Settings [OT3-99].
- [ ] Friends/invites: invite a friend, they accept and arrive beside you, including indoors [OT3-100 scenario].
- [ ] Handle limit is 20 everywhere in the sign-up/launcher forms [OT3-137].
- [ ] Accessibility: tabs/dialogs are keyboard reachable (Tab traps in dialogs, focus returns on close), chat has a polite live region, reduced-motion is honoured [OT3-145]. Note: not yet tested with a screen reader.

## 3. Economy, trade, storage

- [ ] Trade window between two players with double confirm; items/gold are held in escrow; cancelling returns everything; **no duplication or loss** after 20 repeated trades [OT3-177].
- [ ] Bound quest items cannot be traded, dropped or moved by any path, and the player is told why ("bound") [OT3-178].
- [ ] Personal stash in a rented-room chest / guild strongbox keeps items across logout [OT3-179].
- [ ] A cell reset does not wipe your deposits; take-and-return nets to zero [OT3-126].
- [ ] Rent expires after one **personal** day: a rested player's rent runs out later than a non-resting player's [OT3-153 (needs this manual check)].

## 4. Griefing and PvP (try to break it)

- [ ] A stranger cannot kill or lock-out story NPCs (Fargoth in Seyda Neen); 3+ players can talk to Fargoth at once [OT3-164, 155, 160].
- [ ] Quest and unique loot is per player; a stranger cannot take your quest item [OT3-165].
- [ ] PvP only by consent: duel, town flag with cooldown, or Arena zone; no PvP in Seyda Neen; sprout protection to level 5 [OT3-163, 162].
- [ ] No mind control, soul trap or teleport spells land on players (Command, Frenzy, Calm, Lock, Telekinesis rules) [OT3-169].
- [ ] Dropped-item litter is capped per player and per cell [OT3-167]. Timeouts release stuck object claims and dialogue sessions [OT3-168].
- [ ] A player cannot delete or relock content placed by the game; only what they placed themselves [OT3-5].

## 5. Security smoke (one tester plays the cheater)

- [ ] Devtools `omw.queue` / `omw_debug_*` do nothing on a release build [OT3-6, 13].
- [ ] A hand-edited inventory snapshot (unknown record id, absurd gold) is refused [OT3-15, 7].
- [ ] A spell hit without a real cast does not land [OT3-8]. Skill-book reads survive relog [OT3-16].
- [ ] A banned account's session dies within a minute and the ban follows the OAuth identity, not the name [OT3-4].
- [ ] No verified ESM means no `/mwdata` and no join; a fake ESM fails verification [OT3-1, 2].

## 6. Staff tools (a staff account)

- [ ] `/rename` a character (offline and online); the old name is in the audit row [OT3-194].
- [ ] Unstick, restore an item, per-character quest reset, point-in-time character restore all work and each writes an `admin_audit` row [OT3-180..184].
- [ ] Reports have context, status and assignee; bans have a reason and an expiry [OT3-187, 188].

## 7. Stability and capacity (watch while the above runs)

- [ ] 4-person party for 1 hour: no disconnects, no growing lag; server RSS flat [OT3-102].
- [ ] Idle bandwidth per player does not grow when a 5th and 6th tester join (PresenceDelta) [OT3-76].
- [ ] Reconnect: close a tab and reopen; you return where you stood with your journal and items intact [OT3-134 scenario].
- [ ] Capacity note: the Node-only soak showed the first wall at a hub of about 100 players in one cell; the real peer-in-the-loop number is not measured yet (OT3-74, OT3-139).

## 8. Capped open beta (OT3-161)

Only after sections 1-7 pass with a human party.
- [ ] Set the player cap deliberately (`limits.maxPlayers`, today 256 by default; choose the beta number) and optionally `limits.maxVisiblePlayers` (0 = off) [OT3-139, 197].
- [ ] Off-box uptime probe and alerting exist and a stopped world pages someone (module 20: OT3-133, 136, 140) before inviting outsiders.
- [ ] Backups: the hourly backup restores (`restore-drill.sh`) [OT3-63, 66].

## Known gaps to tell testers up front

- Phases (stronghold stages, per-viewer colony), story-boss attacker scaling, the arrival stagger in Seyda Neen, ModRegion/endgame-blight weather and server-enforced difficulty are deferred past 2.0 (see the Plane comments).
- Engine-run behaviours (script item relay OT3-72/75/138, busy avatars OT3-105) are covered by compile and unit checks and the sweep, not by a human yet.
- Dashboard pages are the owner's (frozen): live map, peer health, page map.
