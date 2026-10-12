# Backlog triage (2026-10-12)

Every row still open, partial or undecided in MP-BACKLOG.md, sorted so the work can be
planned. Categories:

- **DONE (stale tracker):** the test that covers the row exists; the row was not updated.
- **SERVER:** a fix in server/src with a unit test. Cheap to batch.
- **ENGINE:** needs a C++ or Lua change in the engine and a rebake. Costs one full build cycle.
- **REPRO:** the cause is not known; needs a scenario run to produce evidence first.
- **DESIGN:** a decision the owner has to make, not a bug.
- **OPS:** dashboard, hosting, runbook or release work.
- **FEATURE:** a missing feature, not a regression.

## DONE (stale tracker, verified)

81 (handleLevel rate-limits steps), 82 (worldstate.test "a gold drop without fromInventory is
still a drop"), 84 (worldstate.test "ActorAI travel is bounded to two cells of the actor").

## SERVER

125 (session token in an auth-link query string, dead in gateway mode: remove the route or move
the token to a POST body), 190 (wire version handshake: check proto on connect and refuse on
mismatch),.

## ENGINE (C++ or Lua, needs a rebake)

130, 227, 296, 312, 314, 351, 217, 221 (StartCombat from a peer-run branch, half open),
220, 267, 268, 265, 266, 203, 109, 111, 112, 113, 107, 106, 108, 73, 75, 77, 78, 80, 59, 52,
54, 55, 56, 57, 58, 28, 29, 30, 32, 44, 45, 47, 49, 50, 157, 148, 232, 243, 246, 323,
304, 305, 387, 100, 126

## REPRO (cause unknown; a scenario run must produce evidence first)

517 (a player's body stops being simulated after its first swing; diagnostics are in place,
needs a run of the fight scenario), 519 (the body stops ~63 u short of the client at a wall),
427 (strength damage reads back 0 after a relog), 183 (A's client goes silent after a snapto),
240 (weak asserts in s137/s149/s110), 246 (s20 asserts the sender's own mirror only).

## DESIGN (owner decision)

361 and 363 (cheats: a free teleport through PlayerCellChange; a follow claim with no dialogue
lock). Both need the owner's call: the dialogue-lock guard is kept as the default, option B.
79 (escort claim with no dialogue lock: same decision as 363). 83 (a plausible first chest
becomes canonical: the adversarial test pins this as intended). 204 (a WebSocket stall above
0.35 s collapses inputs: a design ceiling). 284 (two-device presence and resume: a product
choice). 526 (community copy of a stock data file: the plugin-swap decision from 1.5.0).

## OPS

173, 175, 180, 181, 195, 377, 87, 127, 114, 88, 381, 89, 101 (nametags), 139 (feature gaps)

## FEATURE (missing, not a regression)

261 (party marker on the map), 139, 101, 50 (map exploration and custom markers persisted),
351 (battle music for NPC-vs-NPC fights), 29, 30, 32.

## Notes

- 361 and 363 are the HIGH-severity cheats on the list. They are the first decisions to make.
- ENGINE items are not started. Each batch needs one rebake (about 35 minutes) and one harness
  run; batch them rather than running one per item.
- This file is the plan, not proof. Each row moves to done only with a test that fails without
  the fix or a green scenario.
