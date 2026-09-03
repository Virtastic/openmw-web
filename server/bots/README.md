# Test companions

`soak.ts` proves the server survives load. `companion-bots.ts` gives you players to
*interact with*: they accept friend requests, party invites and world invites,
and answer chat.

```bash
npx tsx bots/companion-bots.ts --port 9000 --data /path/to/shared-dir --names Ashka,Drels,Vera
```

`--data` is the server's SHARED dir. The bots write the same two rows the SSO
callback writes (an account + a login ticket), so the server's SSO-only posture
is unchanged — no password path is opened.

## When the server runs in a container

A macOS bind mount does not share SQLite's WAL shared-memory, and the world
caches accounts in memory at boot. So mint inside the container and restart it
once, then pass the tickets in:

```bash
docker exec omw-mp node -e '...mint accounts + tickets...' > /tmp/tickets.txt
docker restart omw-mp          # drops the cached account rows
npx tsx bots/companion-bots.ts --port 9000 --names Ashka,Drels,Vera --tickets "$(cat /tmp/tickets.txt)"
```

Bots need a COMPLETED character with an appearance: the shared world refuses
anyone still in creation, which is the right rule for players and just means a
bot has to arrive pre-made.

## Sweep

`sweep.ts` plays as a real client and asserts every social feature end to end
against a running server with bots present:

```bash
npx tsx bots/sweep.ts --port 9000 --ticket <t> --ticket2 <t> --bot Ashka
```

It is idempotent — a rerun finds you already friends / already partied and
passes — except quest ids, which are fresh per run because a repeat of an index
already recorded is non-monotonic and stored without relaying (M6).

`--ticket2` is a second real player, needed because the server relays a journal
entry to everyone EXCEPT its author.
