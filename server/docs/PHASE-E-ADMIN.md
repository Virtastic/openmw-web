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

## E3: rank scope (settled: one world)

Rank is a single global number on the account (`0 player, 1 mod, 2 admin, 3 owner`). There
is one public world and no hosted sessions, so there is exactly one scope and nothing more to
build. The `world:<id>` / `session:<id>` split proposed here earlier is dropped (OT3-64). If
private sessions are ever built, they must not reuse the global rank: hosting a session must
not make anyone staff of the public world.

## E3: the window (removed)

The in-game admin window (`scripts/mp/adminui.lua`) and the typed `/slash` path were
removed once the web dashboard existed: two routes to the same actions were two places for
the rank check to be wrong, and one of them lived on the player's machine. Operator commands
now enter only through the dashboard's console (`POST /admin/api/command` → `Admin.exec`),
which the multiplayer server proxies to the world process (`/admin/api/world/*`). The server
gate is, as before, the only authority.

## Verification

- A host kicks from the in-game menu; the kick appears in the audit log.
- An assigned world admin can act; a non-admin cannot — asserted against the SERVER's
  refusal, not against the button being hidden.
