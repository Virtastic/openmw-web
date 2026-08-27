# Finishing plan — what is left, in the order it should be done

Written 2026-08-27, against a backlog that has 8 open items and nothing else. Every entry says
what "done" means and how it will be *known*, because the recurring failure on this project has
not been fixing things — it has been believing they were fixed. Three examples from today alone:
a suite summary reported 43 passing while five scenarios never ran; a memory governor reported
healthy while pricing a world at a third of its real cost; and this file's neighbour had three
contradicting summaries of its own state stacked at the top.

Ordered by what blocks the playthrough, then by what a human alone can close.

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

## 3. `s43-avatar-load` at 8 concurrent players

**State.** Fails even alone. NOT a roster cap and NOT a propagation bug — both read in source:
`players.ts` sends the whole `humansInWorld()` list with no cap or slice and announces every
arrival; the client handler dedupes by id, appends and re-mirrors. The bots are exonerated too:
`alive=0/8` was soak's own broken health metric (`fetch failed` → NaN), while `vis=7.0/7` proves
all eight connected and saw each other.

**So the observer's roster is what stalls.** One concrete lead: in a failing run's server log,
`w8_0` through `w8_7` all appear EXCEPT `w8_4`.

**Next step.** Instrument the wait rather than theorise — log the roster length on each poll, so
the failure says whether it reaches 8 and stops (an off-by-one against the `target + 1`
assumption) or stalls lower (a real delivery gap). No engine build; one scenario edit.

**Scope.** 8 simultaneous players is well past the target of two-to-four friends. Worth
understanding, not worth blocking on.

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
