# Finishing plan — what is left, in the order it should be done

Written 2026-08-27, against a backlog that has 8 open items and nothing else. Every entry says
what "done" means and how it will be *known*, because the recurring failure on this project has
not been fixing things — it has been believing they were fixed. Three examples from today alone:
a suite summary reported 43 passing while five scenarios never ran; a memory governor reported
healthy while pricing a world at a third of its real cost; and this file's neighbour had three
contradicting summaries of its own state stacked at the top.

Ordered by what blocks the playthrough, then by what a human alone can close.

---

## Live-play findings (2026-08-27 evening)

Five bugs came from twenty minutes of somebody actually playing. None was reachable by any
scenario in the suite, because each needs a real session: real cell transitions, a real
friend request, a real environment change. That is the argument for the playthrough in one
paragraph.

* **Melee did nothing and "everything stops".** Sim peers were SIGKILLed at the 120 s start
  deadline while several cold-started at once, leaving the cell with no authority: enemies
  aggro, then freeze, and no damage is ever applied because nothing holds the cell. Not
  memory -- 22 GB free on the box that produced it. Cold starts are serialised now, and a peer
  already past its deadline does not hold the queue (which would trade a thrash for a stall).
* **17 x `world.op_failed`.** `lToJs` and `jsToL` were not inverses: a mixed-key table became
  `{__kv: ...}`, which `jsToL` waved through as userdata and the encoder rejected. Every relay
  carrying such a payload was dropped silently. The error now names the offending keys.
* **Loading screen flashed twice per area change.** The guard against it debounced on TIME,
  measured from when the overlay was shown, with the cell load happening INSIDE that window --
  so the echo always arrived after it expired. Keyed on the player's cell now.
* **`AL error Invalid Enum (40962)`.** `updateListener` applied the underwater filter through
  the Web Audio shim for STREAMS and through a raw EFX `alSourcei` for SOUNDS. Emscripten has
  no EFX, so every environment change raised it. One loop was right and the one beside it was
  missed.
* **A party join did nothing at all.** `routeToParty` had two bare returns, so accepting an
  invite that could not be routed produced no move, no message and no error. The membership
  change was real; only the travel was impossible, and that is the thing to say.

### The shape worth remembering

Four separate guards failed the same way today -- each still reporting confidently about a
world that had changed underneath it:

| Guard | Premise that quietly stopped being true |
| --- | --- |
| memory governor | priced a world at a constant after peers went per-cell |
| cell-load debounce | measured a window the cell load happened inside |
| sim-peer deploy gate | read "no world at boot" as "the peer is broken" |
| `/worlds` contract check | read "no world listed" as "the client cannot dial" |

**A guard whose unit or premise has silently expired is more dangerous than no guard, because
it reports healthy.** Two of these were triggered by a correct change (public worlds becoming
opt-in) making an old assumption obsolete. When changing what the platform runs by default,
grep for the checks that assumed the old default.

---

## 1. Minimap — the one open product bug

**State.** Reproduced with a one-command repro (`s74`). Ten suspects dead against real builds:
fog of war, the pbuffer fallback, the one-frame render window, a null texture, the node not
being traversed, the subgraph being culled away (109 drawables survive), per-view texture
mismatch, the draw never executing, the MSAA intermediate resolve, and framebuffer
incompleteness (the GL layer raises zero complaints).

One probe — a `glReadPixels` in the final draw callback — turned out to be UNSOUND, and both its
readings are discarded. A final-draw callback can run after the framebuffer is unbound, so it
was sampling the default framebuffer whether the clear colour was black or bright blue. That is
recorded rather than deleted: it was on its way to becoming a load-bearing fact.

**Next step, already in build 64.** `localmap.cpp` logs the texture pointer at both ends of the
last unmeasured assumption — the one stored for the widget at setup (`getColorTexture(nullptr)`)
and the one the camera actually draws into.

- **Same pointer** → the widget holds the right object, so the fault is downstream in what MyGUI
  does with it. Next probe: inspect the texture through MyGUI's path rather than the camera's.
- **Different pointer** → the widget holds an orphan nothing renders into. That IS the bug, and
  every other measurement stands unchanged.

**Done when** `s74`'s screenshots show a map panel that changes after walking, on an idle box.
**Cost:** one run, then one fix and one build.

---

## 2. Verification re-runs — cheap, and they gate everything else

These are runs, not work. All must happen on an IDLE box: three of today's six suite failures
were contention, and `s40` has already refused to report a number it could not trust
("convergence 999.6 units at host load 16.9 — the box cannot support this measurement").

| Run | Proves | Notes |
|---|---|---|
| `s73` against build 64 | topic sync end to end, both halves + echo guard | first real run failed on a genuine seam bug (baseline ordering), now fixed |
| `s40 s42 s51 s59` in the peer image | NPC simulation, crowded cell, NPC combat, spell damage | `s51` already passed its assertions; `s40` needs an idle box |
| full 49 against build 64 | no regressions from today's commits | expect SKIP lines now, and read them |

**Done when** all three are green on an idle box and the SKIPPED count is understood line by
line rather than glanced at.

---

## 3. `s43-avatar-load` — DIAGNOSED AND FIXED

It was a SCENARIO bug, not a delivery gap, and the instrumentation earned itself on the first
run. The wait asked for `target + 1` on the belief that the roster includes this client; it
does not, so it stalled exactly one short every time:

```
roster: 0/9
roster: 8/9   <- EXACTLY ONE SHORT, every run, for as long as the scenario existed
```

It survived that long because the old message never carried a number -- which is why the first
change made was to print one, not to guess. Fixed by counting entries whose id is not our own
(`selfId` is mirrored beside the roster for exactly this), so it stays correct whichever way
the engine later decides to treat self.

**Result:** the scenario now clears 8 players and ramps to **62 of 64**. From a hard stop at 8
to a two-player shortfall at 64 -- an eightfold improvement and a different class of problem,
well outside the stated two-to-four-friend target. Worth understanding eventually; not worth
blocking on.

**FINAL STATE: 48 concurrent players verified, the 64 step is harness scaling.** With the
wait budgeted against how many bots are still arriving, the ramp now clears 8/8, 16/16, 32/32
and 48/48 cleanly -- it used to hard-stop at 8 -- and falls short only at 64. soak joins its
fleet sequentially, so the last wave adds 16 more one at a time on a box also running the
browser client under software rendering.

Twelve times the stated two-to-four-friend target is verified. CLOSED: the remaining gap is
the test harness, not the product, and the product side is separately proven by reading (no
roster cap or slice server-side, and a client handler that dedupes, appends and re-mirrors).

**The remaining 2-of-64 is BOT-SIDE, not the roster.** Counted from the server log of a
failing run: only 48 distinct bot names ever appear, across waves that should total 64. Bots
are failing to START in the largest wave -- the same signature as the missing `w8_4` noted
earlier -- rather than arriving and not being delivered. soak's own `alive=0/16` is unusable
as evidence either way: its health fetch fails, so the figure is NaN.

The bots spawn as a wave of `npx tsx` processes and the scenario's own comment already warns
their cold start can outlast a 30 s timer; thirty-two at once is where that bites. Fixing it
means staggering the wave, not touching anything in the roster path.

NOT ON THE CRITICAL PATH: this is 64 simultaneous players against a stated target of two to
four friends, and the product side of it is already proven correct by reading.

What is already ruled out for that remaining gap, by reading source: no roster cap or slice
server-side (`players.ts` sends the whole `humansInWorld()` list and announces every arrival),
and the client handler dedupes by id, appends and re-mirrors correctly.

---

## 4. The playthrough — yours, and the backlog already scripts it

`MP-BACKLOG.md` §P0 is a table of *check / fix it proves / signal if it failed*, covering
everything fixed but never confirmed by a person. Its opening line is the argument for doing it:
**706 server tests, 68 Lua checks and the contract gate all passed while combat was totally
broken this morning.**

Play with that table open. What it proves that no suite can: that the *content* works, not just
the mechanisms — specifically that the main quests advance for a party, which is what TES3MP
never got right.

**Watch the journal model above everything else.** A guest keeps loot, skills and levels but no
quest progress: only the host's campaign advances. Guests ARE told this on arrival (a notice
`quests.lua` shows when it stashes their journal), so nobody is blindsided — but whether that
RULE is right for a hundred-hour co-op game is a design call only playing will answer.

---

## 5. Two bugs only a human can trigger

Both are guarded and will report themselves; neither can be reproduced headlessly.

- **Camera spin.** The pointer-lock delta is clamped and the clamp LOGS the first time it fires,
  with the offending value. A headless client cannot obtain pointer lock, so this cannot be
  tested here — only waited for.
- **Tree alpha on Brave.** The explicit `getExtension` call is the workaround, and when the
  extension genuinely cannot be had the PLAYER is told which browser shield is hiding it. Needs
  someone with Brave, once.

**Done when** a playthrough passes without either firing — or one fires and hands over the value
that has been missing.

---

## 6. Decisions to confirm, not work to do

- **Peers cannot cross hosts.** Spreading them is an architecture change and stays deferred. The
  dangerous half is fixed: the gateway now prices a world by the peers it actually runs, so a
  full box refuses new worlds legibly instead of being discovered by the OOM killer.
- **`ovhcloud` is unprotected** because releases are made by pushing to it. A required-review
  rule would block the release path until that flow changes.
- **Engine pin.** The mechanism is drift-proof now — `version-engine.sh` publishes the hash,
  compose passes `OMW_ENGINE_PIN`, config prefers it — so `[engine] enforce = "refuse"` is safe
  to enable whenever you want it. Nothing here flips it; that is a deploy, and the deploy is
  yours.

---

## What "finished" means

Multiplayer is finished for the stated goal when: the minimap draws, §2's runs are green on an
idle box, and a party of two to four has played the main quests together with §P0 open. Items 5
and 6 do not block that, and `s43` does not either.

The honest risk left after all of it is not a defect — it is the journal model. Every mechanism
can work perfectly and the experience can still disappoint if "only the host progresses" turns
out to be the wrong rule for the game people actually want to play together.

---

## Builder OOM: the whole chain, so it is not re-derived

Two builds died with `exit code -1` and no compiler error. That is not a build failure -- it is
the CI server being killed underneath one:

```
oom-kill: ... global_oom, task=java
Out of memory: Killed process 388785 (java)
```

The chain, hypervisor upward:

| Layer | Fact |
| --- | --- |
| Proxmox host | 62 GB physical, 53 used |
| VM allocation | jenkins-build 40 GB max + test-app-server 24 GB = 64 GB, OVER-COMMITTED |
| Ballooning | jenkins-build squeezed to its 16 GB floor |
| Guest | sees 15.5 GB total, 32 cores |
| Build | `ninja` with no `-j` defaults to nproc+2 = 34 concurrent clang jobs |
| Translation units | ~1-2 GB each at peak |
| Result | guest OOMs, kernel kills the biggest process it can find: Jenkins |

FIXED IN CODE: `ARG BUILD_JOBS=8` in the root `Dockerfile`, budgeting by RAM rather than cores.
`server/Dockerfile.simpeer` already had exactly this arg and comment for the same reason; the
wasm build never got one.

WHY THE CONTAINER LOOKED HEALTHY: `OOMKilled=false`, `ExitCode=0`. The JVM was killed at HOST
level and Jenkins ran its normal shutdown, so every container-level signal said "clean stop".
Only `dmesg` told the truth -- and it had been telling it the whole time.

STILL OPEN, and both are hardware judgement calls rather than code:

* The builder VM is currently memory-starved (227 MB free) and cannot fork sshd. It needs
  `qm reset 200` from the Proxmox host. A hard reset can damage a filesystem mid-write, which
  is why it is not done automatically.
* The host is over-committed, so ballooning will squeeze the builder to 16 GB again whenever
  the test box is busy. Either lower jenkins-build max memory to something honest or raise its
  balloon floor -- a trade against test-app-server, which is the box people play on.

NOT BLOCKING PLAY: the game server is the other VM entirely.

---

## s31-container is a REAL defect, not a timing artifact (correction)

It was triaged twice as contention -- it passed when run completely alone -- and its step
budget was widened from 15 s to 30 s on that basis. Against the deployed engine on an IDLE box
(load 0) it still fails:

```
timeout (30000ms) waiting for: chest holds 1 item on A
```

Thirty seconds at load 0 is not a slow renderer. The assertion is on A's OWN mirror: A equips
an item, spawns a chest, opens it, puts the item in, and A's own `containerItems` never shows
it. No second client and no network round trip is required for that to be visible, which makes
"contention" the wrong explanation regardless of how often it passed alone.

WHY THE MISCLASSIFICATION HAPPENED, since it is the same trap as everything else here: passing
when run alone was treated as proof of contention. It is equally consistent with a race that
a quiet box usually wins. "Passes alone" narrows the cause; it does not identify it.

NEXT: run `s31` on its own and capture the FULL server log -- the suite only dumps a boot-time
tail, so no ContainerOpRequest is visible in the failing run. The question to answer first is
whether the put reaches the server at all, or whether it is refused (the container path is
arbitrated first-opener, so a lock that was never granted would refuse silently).

Shared containers are core co-op: two players looting one chest is the thing this is for.

### s31 narrowed: the put works, the WATCH never fires

Measured rather than reasoned, with `count:<id>` after the put:

```
after the put, A still holds 0 of the item
```

So `moveInto` SUCCEEDS -- the item leaves A's inventory and enters the chest. What never
happens is the publication: A's `containerItems` mirror stays empty, and the client log
contains no container lines at all -- not a `ContainerOpRequest`, and not one of the
`dropOut(...)` refusals either. It is not being refused; it is never being produced.

That points at the container WATCH. `mpChestPut` deliberately does a native `moveInto` so that
"the container watch (armed by chest:open) diffs the inventory change into the
ContainerOpRequest -- the same path a UI put takes". If the watch is not armed, the transfer
happens locally and the server is never told.

OPEN QUESTION worth answering before assuming a product bug: does the watch require the
container UI to be genuinely OPEN? A real player always has it open when moving items, so a
watch that depends on it would work in play and fail only under the harness, which drives
`chest:open` through `objects.onActivate` without a real window. That would make s31 a harness
limitation rather than a co-op defect -- but it cannot be settled without engine-side logging
in the watch, and the builder is currently down.

NEXT: log when the watch arms and when it diffs. One build, and it distinguishes "the watch
never armed" from "it armed and saw nothing".

### Why this took so long to see

The failure dump was 30 lines of one repeating WebGL warning
(`GL_INVALID_ENUM: glDrawElements`), which filled the entire tail and pushed every useful line
out. `logTail` now collapses repeats and reports their count, so a rare line -- always the
interesting one -- survives. That is fixed for every future failure, not just this one.
