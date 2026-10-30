# OpenTES3 (v2): module gate evidence

Status as of commit `7539ea3d` on `OpenTES3` (nothing pushed). Gates are the pass/fail tests written
in each Plane module description (project OT3). **No module gate is signed off yet**: the full harness
sweep on the final head has not run (see "How to close a gate"). This file separates what has been
measured from what is still open, so nobody reads a green unit suite as a passed gate.

Legend: **local** = measured by `bash wasm-build/lua-tests/run.sh` (817 checks) and `cd server && npm test`
(1452 tests, 1451 pass, 1 skipped, tsc clean) on the final head; **sweep** = needs the browser harness
(`ci/jenkins/run-harness.sh`) against freshly built `morrowind:test` + `openmw-mp:tier2`;
**human** = needs people; **owner** = the owner's decision or the frozen dashboard.

| Module | Gate (short) | Local evidence | Still open |
|---|---|---|---|
| 00 Prod hotfix | release strips test hooks and debug exports; patched snapshot refused | Lua runner: hooks off unless the bake wrote buildflags; server tests for the record whitelist and gold cap | sweep on a release-style bake; P7 (dashboard) is **owner** |
| 01 Security | no verified ESM = no `/mwdata` and no join; bans revoke sessions; placed objects protected | locker-esm, mwdata-serve, ban/session and object-ownership tests | sweep; H6 `/admin` TOTP is In Review; origin-firewall/Cloudflare items are **owner** (cancelled in Plane as ops) |
| 02 Death expiry | only levelled spawns and respawn-flagged actors expire | server tests | actor/death scenario on a fresh peer after 80 game-hours (**sweep**) |
| 03 Quest/phase generator | 20 cells + 20 quests spot-checked in game | generator runs in the image build | **human** spot-check |
| 04 Progress attribution | peer writes A's stage, B's doc byte-identical; non-admin joins ownerless world | server tests (`step7gate`, attribution) | **sweep** |
| 05 Server-owned character | cheat bot gains nothing; no false flags over 4 h | ledger/chargen/spell-record server tests | cheat-bot + 4 h honest run (**sweep**); OT3-95 (script classes on the peer) is **open, needs a design** |
| 06 One world | 20 bots on distinct characters in one world; old characters resume | single-world tests, migration test | 20-bot run (**sweep**); OT3-149 deferred to module 23 |
| 07 Per-character progression | two players on one quest at different stages both finish | `step7gate.test.ts` (two players, one quest) and per-character journal/global/topic tests | in-engine two-client run (**sweep**) |
| 08 Interest index | 500 bots/50 cells; each event reaches only its 3x3; loop lag p99 < 20 ms | `interest.test.ts`: every relay reached exactly its occupants; 10k relays about 31 ms, per-relay p99 0.0075 ms (relay slice only) | live loop-lag p99 with real bots (**sweep**) |
| 09 Roster delta | idle bytes/s/player flat from 50 to 500 bots | `presencedelta.test.ts`: 0 idle PresenceDelta bytes at 50 and 500 simulated players | engine rebake exercises the Lua handler (**sweep**) |
| 10 Batched persistence | 1,000-doc flush blocks the loop < 50 ms; kill writes no `world_global`; restore drill | `killtable`, `nowdebounce`, transaction tests | `restore-drill.sh` against a real hourly backup (**sweep/ops**) |
| 11 Cell queues | race test passes; RSS flat over a 2 h, 2,000-cell tour | `cellqueue.test.ts` (race on two cells and one cell, throw rollback) | 2 h RSS tour (**sweep**) |
| 12 Parties | scripted party of 4 runs 10 quests; 3 bots on a mudcrab all get credit | party/quest-credit/helper-reward/party-frame tests; Lua runner for the client | harness run (**sweep**), **human** party playtest |
| 13 Clock and crime | 50 resting bots do not move the world clock | `worldtime`, personal-clock and jail-timer tests | 50-bot run; OT3-153 rent/restock check (**sweep**) |
| 14 Grief locks | griefer bot fails every row of the griefing and spell tables; 20 bots talk to Fargoth | grief-table, PvP-consent, spell-rule and dialogue-lock tests | griefer-bot run (**sweep**); arrival stagger OT3-147 deferred |
| 15 Death, trade, storage | 1,000 scripted trades, no dup or loss; bound item cannot leave | trade, stash and bound-item tests | 1,000-trade run (**sweep**) |
| 16 Staff tools | admin restores one character to an hour ago while 20 bots play; audit row | staff-rename, offline-staff, audit tests | 20-bot restore run (**sweep**); dashboard pages are **owner** |
| 17 Region peers | published capacity with the peer in the loop; killing one region's peer affects only that region | `regions`, `capacitymetrics` tests; Node-only soak (first wall: hub of about 100 in one cell, 71% CPU, about 3,000 backpressure drops, loaded laptop, indicative only) | real two-peer kill test; capacity number with a peer (**sweep**) |
| 18 Server phases | Raven Rock at 3 colony stages | server-side party/journal phase hints only | **deferred past 2.0** (no phase key in the protocol or engine) |
| 19 Engine variant refs | 100 players across 20 phased cells | none | **deferred past 2.0**, depends on 18 |
| 20 opentes3.com launch | new Google/Discord accounts sign in, upload three ESMs, reach chargen; zero-downtime deploy; stopped world pages someone | front door built | DNS/TLS/OAuth, R2/Worker, alerting, legal sign-off: all **owner** |
| 21 Open | full sweep, human playtest, capped beta | `docs/QA-PLAYTEST-V2.md` | sweep (**sweep**), playtest (**human**), beta (**owner**) |
| 22-25 | cleanup, built-in performance, WebGPU | not in scope for 2.0 | unscheduled |

## How to close a gate

1. Build the images from the commit under test and run the full sweep (commands in CLAUDE.md,
   "Build and sweep commands"). The machine must be otherwise idle: the harness has 4-5 s timing
   assertions and a load of 60+ makes them fail for reasons unrelated to the code.
2. Triage each failure as: stale scenario (see `wasm-build/mp-scenarios/RETIRED.md` for how the
   retired ones were handled), load flake (re-run alone), or real bug (fix, then re-run the failures).
3. Move a ticket from Awaiting Bake/Sweep to Merged only when the scenario that covers it passes on
   the final head, and paste the verdict line on the module.
