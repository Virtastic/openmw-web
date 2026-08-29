# Lua-initiated player teleports silently do nothing

**Status:** open, root cause not found. Pre-existing on `origin/dev` — NOT introduced by
`perf/opentes3`, verified by building `dev` and running the same scenarios against it.

**Impact:** "travel to a friend" is broken in multiplayer. You accept an invite and stay exactly
where you are, with no error and no message. Almost certainly the same cause behind party travel
and respawn.

## Scenarios this accounts for

| scenario | assertion that fails | shared shape |
|---|---|---|
| `s45-social` | `accepting an invite did not move the character (0.0 units)` | server-initiated teleport |
| `s54-party-travel` | `A received the party's destination` (timeout) | server-initiated teleport |
| `s22-death` | `A must be away from the respawn point` | respawn teleport |

Three independent call sites, all of which move the player from Lua, all failing. `s22` and `s54`
have not been instrumented — they are listed because the shape matches, not because it is proven.

## What is established, with evidence

Instrumented `MP_InviteAccepted` in `scripts/mp/global.lua` and read the values back through
`mp.testSet` (which lands on `window.__omwMP`):

```
target = (216831.0, 205429.0, 513.0)   cell=""
player = (216831.0, 204909.0, 513.0)   posOk=true
player:teleport(...) returned  ok=true  err=nil
```

1. **The server sends the right thing.** `SocialService.acceptInvite` (`core/social.ts`) returns the
   HOST's `cellKey` and pose, not the accepting player's. The target above is ~520 units away,
   consistent with the scenario walking B away before inviting.
2. **The client handler runs** and receives that data intact.
3. **The teleport call succeeds.** It is wrapped in `pcall`; `ok=true`, `err=nil`. It is not
   throwing and not hitting the `notice('Could not travel to them just now.')` path.
4. **The arguments are correct.** `inviteCellArg` returns `""` for an exterior cell key like
   `26,25`, and `findCell` (`mwlua/objectbindings.cpp`) maps an empty name to the default exterior
   worldspace and derives the cell FROM the position. That is the intended usage.
5. **The action queue runs.** `teleport` on the player goes through
   `LuaManager::addTeleportPlayerAction`, applied by `applyDelayedActions()` inside
   `synchronizedUpdate()`, which `engine.cpp` calls every frame. `?perfstats=1` measures
   `luasyncupdate` at 0.336ms/frame, so that phase is live.
6. **The player does not move.** 1500ms later the pose is unchanged — 0.0 units.

Reading the position immediately after the call is NOT evidence of failure: the teleport is
queued, so the same-frame read showing the old position is expected. The 0.0 measured by the
scenario is taken 1500ms later and is the real signal.

## Ruled out

- **Wrong coordinates / own position echoed back.** Target is 520 units away (measured).
- **Wrong party leader.** `partyAccept` sets `leader: fromAcct` (the inviter), and the
  `InviteAccept` path uses `acceptInvite`, which returns the host directly.
- **Stale server pose.** `player.pose` is updated on every `PlayerMove` (`net/connection.ts:779`).
- **Bad cell argument.** See 4 above.
- **Server anti-cheat snapping the player back.** The plausibility check
  (`net/connection.ts:744`) only REFUSES a pose server-side, in the lobby, after 3 strikes. It
  never pushes a correction to the client.
- **A crashing handler.** `pcall` reports success.

## Where to look next

The action is queued with correct arguments and reports success, and the queue is drained every
frame — so either the `DelayedAction` does not execute, or the position is restored after it does.
Instrument `LuaManager::applyDelayedActions` / the `TeleportPlayer` action directly, and log the
player position immediately before and after it applies. If it applies correctly, something later
in the frame is overwriting the position, and the MP pose-sync path is the obvious suspect.

## Traps that cost time here, worth knowing before you start

- **`print()` from Lua is invisible.** The harness only dumps engine logs for some failure kinds;
  an assertion failure shows none. Use `mp.testSet(key, value)` and read `window.__omwMP`.
- **`mp.testSet` takes (string, string) only.** A number throws, and a throwing handler dies
  silently mid-way.
- **Do not put a probe inside a `pcall` you also rely on.** An unguarded `player.position` threw
  and killed the handler before `testSet('invitedTo')`, which cost a 900s scenario timeout; the
  guarded version then swallowed its own error and made the handler look like it never ran.
- **`openmw.data` must be redeployed for Lua changes.** Copying only `openmw.js`/`.wasm` leaves the
  old scripts baked in and the build looks updated. Verify with
  `grep -c <your-marker> play/openmw.data`.
- **Anchor edits on the enclosing function, not on a pattern.** Anchoring on the first
  `pcall` + `player:teleport` in `global.lua` lands in `teleportPlayerTo()`, not
  `MP_InviteAccepted` — which produced a confident and completely wrong "the handler never runs".
