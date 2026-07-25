# openmw-mp — what the server stores

This document describes **everything** an `openmw-mp` server keeps about a player, where it
lives, how long it stays, and how to erase it. It is written for the operator: you are the
data controller for the server you run, and this is the inventory you need to answer a
player who asks "what do you have on me, and can you delete it?".

Nothing here is sent anywhere else. The server has no telemetry, no analytics, no outbound
network calls of any kind.

## Stored data

Everything lives under the data directory (`--data`, `/data` in the container).

| What | Where | Why |
|---|---|---|
| Account name (as registered, plus a lowercased key used as the filename) | `accounts/<name>.json` | identifies the account across sessions |
| Password hash — argon2id, OWASP 2024 baseline (m=19456 KiB, t=2, p=1) | `accounts/<name>.json` | authentication. The password itself is never stored and never logged |
| `createdAt` / `lastSeenAt` timestamps, rank (0-3), banned flag | `accounts/<name>.json` | moderation and operator visibility |
| Character document: appearance, equipment, inventory, stats, spells, position, journal, factions, bounty | `players/<name>.json` | the character has to exist between sessions |
| Ban entries: banned account name, or **IP address** for an IP ban, plus who banned, when, and the reason | `bans.json` | enforcing bans across reconnects |
| World state: cell deltas, containers, custom records, clock, weather | `world/` | shared world; keyed to cells and objects, **not** to people. The only per-player trace is a transient session `playerId` on objects a player spawned, which is a per-session number and not an identifier |
| Session/resume tokens | memory only | never written to disk; discarded on restart and when the window (`[login] resumeWindowSec`) expires |

**IP addresses**: the server holds a client's IP only for the lifetime of the connection
(per-IP connection and auth-attempt limits). It is written to durable storage in exactly one
case — an **IP ban** — and it is written to your **logs** (see below). Lifting the ban erases
the address.

## Logs

The server writes single-line JSON to **stdout** and never manages log files itself, so
retention is whatever your process supervisor does with that stream. Log lines include IP
addresses (connection open/refuse, auth, bans), account and display names, chat text,
admin actions, and — for `/console` — the full script that was sent to a client.

**Recommended: 14 days.** With systemd:

```
# /etc/systemd/journald.conf.d/openmw-mp.conf
[Journal]
MaxRetentionSec=14day
```

With Docker, cap the json-file driver (size-based, roughly a fortnight of a small server):

```yaml
logging:
  driver: json-file
  options: { max-size: "10m", max-file: "3" }
```

If you promise players a retention period, configure it — this file cannot enforce it for you.

## Erasure

To honour a deletion request, stop the server (or run against its data directory while the
account is offline) and:

```sh
node dist/server.mjs --data /data --delete-account "Player Name"
```

This removes `accounts/<name>.json` (name, password hash, timestamps, rank) and
`players/<name>.json` (the whole character), and lifts any ban entry naming that account —
a ban cannot outlive the data it names, so re-ban by IP first if you need the block to stick.

It deliberately does **not** rewrite world state (it contains no personal data) and cannot
rewrite your logs. After erasing, purge the name from rotated logs, e.g.
`journalctl --vacuum-time=1s` for a full wipe, or grep the name out of archived files.

## Retention summary

- Accounts and characters: kept until the account is erased. Operators who want to expire
  dormant accounts can delete files older than a chosen `lastSeenAt` — the server treats a
  missing account as "never registered".
- Bans: kept until lifted with `/unban`.
- Resume tokens: at most `[login] resumeWindowSec` (default 300 s), memory only.
- Logs: your retention policy; 14 days recommended above.
