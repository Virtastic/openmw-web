<!-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app -->
<!-- SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web -->
# Phase C — friends, presence, invites

Design, not evidence. Nothing here is validated by research or by play; it is the smallest
shape that delivers the user-visible goal ("friends can see each other and join on the
fly") without inventing infrastructure the single-world decision removed.

## What the one-world decision changed

The earlier plan had this blocked on a storage fork: with 10 world processes, friends and
presence are inherently cross-process ("your friend is online in a *different* world"), so
a local database could not express them and a shared identity service was the recommended
answer.

**One world means one process.** Accounts, friends, presence and bans all live in the same
place as everything else, so `node:sqlite` in the existing data dir is correct again and
the shared service is not built. If region-sharding one map across processes ever happens,
this is the decision to revisit — not before.

## Storage

`node:sqlite` (no new dependency), one file in the data dir, alongside the existing JSON
stores rather than replacing them:

- **Relational data goes to SQLite**: the friends graph, blocks, and pending invites. A
  friends graph in per-entity JSON files means reading every file to answer "who are my
  friends", and worse, two half-written files after a crash mid-mutation.
- **Everything already working stays JSON**: cell docs, player docs, accounts. There is no
  benefit in migrating them and a real risk in rewriting persistence that a 30-minute soak
  currently proves clean.

Friendship is stored **once per pair**, not twice, with the lower account id first. Storing
both directions means a half-applied mutation can leave A friends with B while B is not
friends with A, and every read has to decide which direction is authoritative.

## Messages

Client → server: `FriendRequest{name}`, `FriendAccept{id}`, `FriendRemove{id}`,
`BlockAdd{name}`, `BlockRemove{id}`, `InviteSend{id}`, `InviteAccept{id}`.
Server → client: `FriendList{friends:[{id,name,online,cellKey?}]}`, `PresenceUpdate{id,online}`,
`InviteReceived{fromId,fromName}`.

Rules that are easy to get wrong and should be tested explicitly:

- **Blocks outrank friendship and invites, in both directions.** A blocked account cannot
  invite, request, or see presence — and blocking must not be defeatable by the blocked
  party re-requesting.
- **Presence is coalesced**, like `MoveBroadcaster`: a player rejoining after a drop must
  not fan out an online/offline storm to every friend.
- **Presence leaks location.** `cellKey` is shown to friends only, never to strangers, and
  never to someone the player has blocked.
- **Invites expire** and are capped per sender, or they are a spam channel.
- Friend requests key on **account, not display name** — names are mutable and reusable.

## Client

`scripts/mp/social.lua`, reusing the recipe already proven in `player.lua`: `ui.create` +
`I.UI.setMode('Interface')` for a modal, `guiRow(text, onClick)` as the clickable row.

Two engine constraints that shape the UI and are not negotiable:
- Windows rebuild by destroy+create; there is no in-place update.
- 0.52 Lua has no programmatic keyboard focus, so any text entry needs a click first.

## Verification

- Two accounts befriend; both see it, and the pair is stored once.
- Presence flips on join and on **drop** (not just clean logout) — the reconnect path is
  where presence goes stale.
- An invite arrives, is accepted, and lands the invitee in the sender's cell.
- A block suppresses invites, requests and presence **in both directions**, and survives
  the blocked party retrying.
- Restart the server: the graph is still there (the point of using a database).
