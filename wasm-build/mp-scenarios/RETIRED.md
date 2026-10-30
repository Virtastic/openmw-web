# Retired scenarios

Scenarios deleted because they only tested behavior that v2 (OpenTES3) removed on purpose.
The removing commits are on the OpenTES3 branch (`git log --grep 'OT3-31'`, etc.):

- OT3-31 `cf438205`: one world, own campaigns; world modes, browser and owner semantics dropped
  (`WorldList`, `WorldCreate`, `JoinFriend`, `SetWorldMode`, `WorldKick`, `WorldMode`, `WorldClosed`).
- OT3-58 `604d46c7`: one world; world switching, the where-row, join-friend and the launcher's
  private boot dropped (client Lua, page and launcher).
- OT3-49 `e5e2e97c`: the per-world `[worlds]` config table is gone.
- OT3-108 `fabb3ec2`: rest and wait move a personal clock offset; the shared sky never skips.

| scenario | what it tested | removed by |
|---|---|---|
| s47-worlds-ui | the Worlds tab in the Social hub: list, create a session, join it | OT3-31, OT3-58 |
| s48-switch-reconnect | a reconnect redials the world you switched TO (private session) | OT3-58 (no world switching) |
| s57-world-revival | a reaped private own-world revives on its owner's dial home from a friend's party | OT3-31, OT3-58 (no private/own worlds; server-side revive of the one world is still unit-tested) |
| s63-guest-journal | the guest sees and writes the HOST's quest log; their own journal is stashed (`borrowed`) for the visit | OT3-31 (`borrowed` is always false; journals are per character, OT3-51) |
| s95-play-with-friends | befriend, host flips Party, guest `joinfriend`s into the host's world, then chats | OT3-31, OT3-58 (no world to join; friend list and chat stay covered by s94, s03, s100) |
| s102-owner-goes-solo | host flips Party back to Solo; guests inside get WorldClosed and are sent home | OT3-31 (WorldMode/WorldClosed) |
| s129-host-vanishes | host's tab closes: 90 s `owner_left` grace, then guests are sent home | OT3-31 (no owner) |
| s139-host-blocks-guest | host blocks a guest already inside: that guest is told why and sent home | OT3-31, OT3-58 (no host-leads-the-world gate). The block itself (friendship ends) is still covered by s97 |
| s140-refused-at-the-door | host flips private while a guest is mid-join; the guest goes home and is told why | OT3-31, OT3-58 |
| s141-host-sends-guest-home | `WorldKick`: host sends ONE guest home with a reason, friendship and open door kept | OT3-31 (WorldKick removed; a party `PartyKick` is a different thing, OT3-106) |
| s142-join-from-launcher | launcher boots straight into a friend's world via `/auth/friends-playing` | OT3-58 (friends-playing removed) |
| s143-leader-level-scales-spawns | the party/world leader's level scales levelled spawns around a low-level guest | OT3-31, OT3-58 (nothing feeds `setPartyLevel` any more; spawns roll on the nearest avatar) |
| s180-guest-leaves | a guest presses Leave / `where:home` and lands in their own world | OT3-58 (no own world to go home to) |
| s195-party-roundtrip | Solo -> a friend's party -> home, and a friend who follows the join across worlds | OT3-31, OT3-58 |
