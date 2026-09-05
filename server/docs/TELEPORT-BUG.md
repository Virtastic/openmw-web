# "Travel to a friend" is NOT broken — the scenarios were

**Status:** RESOLVED. `s45-social` and `s22-death` now pass.

An earlier version of this document claimed Lua-initiated player teleports silently did nothing
and that friend-travel was broken in multiplayer. **That was wrong.** The feature works. The
scenarios were measuring it with a fixed sleep that is too short on a loaded box, and the failure
looked exactly like a broken feature from the outside.

Keeping the trail because the wrong conclusion was reached carefully, from real evidence, and the
thing that finally separated the two explanations is worth knowing.

## What actually happens

The player teleports. Instrumenting `LuaManager::applyDelayedActions` around the `TeleportPlayer`
action shows the engine applying it correctly:

```
before = (216831, 204909, 513)
after  = (216831, 205429, 513)     <- 520 units, exactly the intended destination
```

The test reads `window.omw.state.pose`, which is a **2 Hz mirror** published by
`POSE_MIRROR_INTERVAL` in `scripts/mp/player.lua`. Sampling it instead of reading it once shows
the move arriving and then holding:

```
pose y over 3s: 204909 204909 204909 205429 205429 205429 205429 205429 ...
```

Under software GL on a busy machine the whole round trip — event, queued action, applied
teleport, next mirror tick — runs past the `sleep(1500)` the scenario allowed. One read at the
deadline lands on the old value, so the assertion sees 0.0 units moved and reports that accepting
an invite does nothing.

## The fix

Wait for the condition, do not assume a duration.

- `s45-social`: `sleep(1500)` -> `waitFor(moved > 100)`. **PASSES** (moved 480 units, ends 80 from
  the host).
- `s22-death`: `sleep(3500)` -> `waitFor(distance from respawn > 250)`. **PASSES**.

Both had the same shape: a fixed sleep followed by a single read of the 2 Hz pose mirror.

## Why the wrong conclusion was reachable

Every one of these was true and none of it was the answer:

- the server sends the host's real position, ~520 units away (not the accepting player's own —
  the obvious suspect, correctly ruled out)
- the client handler runs and receives it intact
- `player:teleport(...)` returns `ok=true`, `err=nil`
- the arguments are right: `inviteCellArg` returns `""` for an exterior key and `findCell` maps
  `""` to the default worldspace, deriving the cell from the position
- the action queue is drained every frame (`luasyncupdate` measured at 0.336ms)

All of that says "the teleport is fine", and the observed 0.0 says "it did not happen". The
missing step was instrumenting the ENGINE either side of the action rather than reasoning about
it, which immediately showed the position changing — moving the question from "why doesn't it
teleport" to "why doesn't the test see it".

## If you are debugging this layer, five traps that cost real time

- **`print()` from Lua is invisible.** The harness only dumps engine logs for some failure kinds;
  an assertion failure shows none. Use `mp.set(key, value)` and read `window.omw.state`.
- **`mp.set` takes (string, string) only.** A number throws, and a throwing handler dies
  silently part-way through.
- **Never put a probe inside a `pcall` you also depend on.** An unguarded `player.position` threw
  and killed the handler before `set('invitedTo')` — a 900s timeout. The guarded version then
  swallowed its own error and made the handler look like it never ran.
- **`openmw.data` must be redeployed for Lua changes.** Copying only `openmw.js`/`.wasm` leaves the
  old scripts baked in while everything looks updated. Verify with
  `grep -c <marker> play/openmw.data`.
- **Anchor edits on the enclosing function, not on a pattern.** Anchoring on the first
  `pcall` + `player:teleport` in `global.lua` lands in `teleportPlayerTo()`, not
  `MP_InviteAccepted` — which produced a confident, completely wrong "the handler never runs".

## s31-container: a different fault, characterised but not fixed

Not the same cause, and NOT the "intermittent race" the repo history records — it failed 3/3
consecutive runs here. The scenario's own diagnostic answers the question it was built to answer:

    after the put, A still holds 0 of the item
    (0 = it moved and the mirror is at fault; 1 = the transfer never happened)

So the transfer WORKS and the container mirror does not reflect it on the actor's client. Every
link in that chain reads correct:

  - the server relays `ContainerUpdate` to the whole cell INCLUDING the requester
    (`worldstate.ts`, after `cont.stateSeq++`)
  - `objRefToJs` emits `{ net: netId }`, so the client's key is `n:<netId>` — matching what the
    scenario looks up
  - `MP_ContainerUpdate` updates `containerData[key]` BEFORE the own-echo `return`, so the actor's
    own op still lands in the mirror source
  - the mirror publishes every 0.5s from `objects.tick`, and the scenario waits 30s

Reading has been exhausted; the next step is to instrument `MP_ContainerUpdate` (does it fire on
A, and what key does it compute?) using `mp.set` — NOT `print`, for the reason above.

## The general lesson for this suite

`omw.state.pose` is a 2 Hz mirror, not live state. Any assertion about movement must poll it until
the expected condition holds, with a generous timeout. A `sleep()` long enough on a developer GPU
is not long enough under `angle-swiftshader` in a container, and the resulting failure is
indistinguishable from a real product bug — which is how two working features got reported as
broken.
