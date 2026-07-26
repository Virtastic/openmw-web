<!-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app -->
<!-- SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web -->
# Phase E — sessions, the persistent world, and in-game admin

## What the one-world decision changed

The original brief had two things that the single-world pivot pulls apart:

1. **"Friends join my game on the fly, auto-hosted"** — private, ephemeral co-op sessions.
2. **"Persistent worlds with assigned admins"** — a public, permanent world.

The 10-worlds design made these the same mechanism. One world does not: a public persistent
world is a single long-lived process, while auto-hosted co-op is a fleet of short-lived
ones. **They are different products and should not share an implementation.**

Recommended sequencing, cheapest useful thing first:

- **E3 (admin UI) is nearly free and unblocks moderation of the public world.** The entire
  M8 admin API already exists server-side: rank-gated, audited, with client appliers in
  `scripts/mp/admin.lua`. What is missing is a window and a rank *scope*.
- **E2 (the persistent world) is mostly operations, not code.** One data dir, one process,
  the existing plugin layer for rules. Launch one, not ten.
- **E1 (the orchestrator) is the expensive one and is now optional.** With a single public
  world, a friend joining "your game" can simply mean joining the world and being invited
  to your location — which Phase C already does. Build the orchestrator only if private
  sessions turn out to be wanted on their own, and cost it then; per-user session caps and
  idle reaping are day-one requirements the moment it exists, because the cost model goes
  from one container to N.

## E3: rank SCOPE (the part that is not just a window)

Rank today is a single global number on the account (`0 player, 1 mod, 2 admin, 3 owner`).
That is correct for a public world and **wrong the moment a player hosts anything**: being
the host of your own co-op session must not make you a moderator of the public world, and
the naive implementation — bump the host's rank — does exactly that.

So rank needs a scope before any hosting exists:

- `world:<id>` — assigned public-world staff. Persisted on the account, as today.
- `session:<id>` — the host of a private session, and anyone they delegate. Lives and dies
  with the session; never persisted, never consulted outside it.

Until private sessions exist there is exactly one scope, so the change is small now and
large later. It is listed here so the decision is made deliberately rather than discovered
when someone hosts a game and finds they can ban people from the public world.

## E3: the window

`scripts/mp/adminui.lua`, same recipe as the social window (`ui.create` + modal `Interface`
mode, `guiRow` as the clickable primitive, destroy+create to update). It issues the existing
slash commands rather than inventing a parallel API — the server-side gate, the audit trail
and the refusal messages are already right, and a second path to the same actions is a
second place for the rank check to be wrong.

Rows are filtered by the viewer's rank so the menu shows only what they can actually do —
but the **server gate remains the authority**. A hidden button is a UI convenience, not a
permission; the client must never be the thing deciding.

## Verification

- Two friends auto-host and join with no config *(only if E1 is built)*.
- A host kicks from the in-game menu; the kick appears in the audit log.
- An assigned world admin can act; a non-admin cannot — asserted against the SERVER's
  refusal, not against the button being hidden.
- A session host has no elevated rights in the public world (the scope test — the one that
  fails silently and matters most).
