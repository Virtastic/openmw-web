# openmw-mp

Multiplayer server for openmw-web. It is a **relay / validator / persister**: it routes
chat and (in later milestones) movement/events between browser clients, enforces the
session rules in [PROTOCOL.md](PROTOCOL.md), and persists accounts. It runs **no game
simulation** and ships **no game data**.

## Dev quickstart

```sh
cd server
npm install
npm run dev        # tsx watch src/main.ts (data in ./devdata, port 8080)
npm test           # typecheck + node:test suite (real ws clients on ephemeral ports)
npm run build      # bundle -> dist/server.mjs
npm start          # node dist/server.mjs
```

`npm run lser-dump -- <file.bin>` pretty-prints an LSER blob as JSON.

## CLI

```
node dist/server.mjs [--data <dir>] [--port <n>]
```

- `--data` — data directory. Default: `/data` when it exists (container), else `./devdata`.
- `--port` — HTTP+WS port. Default `8080`. WS endpoint is `/ws`; `/healthz` and `/status`
  are plain HTTP on the same port.

Metrics: `GET /metrics` serves the Prometheus text format, gated on
`Authorization: Bearer <[metrics] token>`. It is off by default and answers `404` (not
`401`) while disabled or tokenless, so the endpoint is invisible until an operator turns it
on. `/status` is unaffected: still public, still unauthenticated.

Signals: `SIGTERM`/`SIGINT` = graceful shutdown (every session gets
`SessionDisconnect SHUTDOWN`, accounts are flushed); `SIGUSR1` = flush accounts now.

## Data dir layout

```
<dataDir>/
  config.toml            # optional operator overrides (deep-merged over config.default.toml)
  accounts/<name>.json   # one file per account (lower-cased name), written atomically
  players/<name>.json    # M2 player snapshot (appearance/equipment/inventory/stats/spells/position)
  world/global.json      # M3 netId ceiling + M4 kill tally + M6 shared journal/globals/factions
  world/cells/<enc>.json # M3 per-cell delta docs (placed/deleted/moved/locks/doors/containers),
                         # filename = encodeURIComponent(cellKey)
  logs/chat-YYYY-MM-DD.jsonl  # A4 durable chat log, one JSON object per line, rotated daily
  reports/<ts>-<reporter>.json # A4 /report inbox (reporter, target + cell, reason, context)
  identities/<sha256>.json    # Phase B SSO: (issuer, subject) -> account, one file per link

```

Player docs are write-behind: flushed on cell change, level-up, equipment change (10 s
debounce), logout, `SIGTERM`/`SIGUSR1`, and a 45 s sweep. Position coordinates are pulled
from the live pose at flush time (move frames never trigger writes).

To seed an admin: register in-game, stop the server (or it flushes within 30 s), edit
the account JSON's `"rank"` to `1` and restart or relog. `"banned": true` blocks login.

## Config reference

Defaults live in [`config.default.toml`](config.default.toml); an operator
`<dataDir>/config.toml` overrides per-key (tables merge, scalars/arrays replace).
Note `plugins` is a top-level key — in an override file it must appear **before** any
`[table]` header.

| key | default | meaning |
|---|---|---|
| `plugins` | `["motd", "respawn", "death-penalty", "pvp", "sharing"]` | built-in plugins to load, in order |
| `[sharing] journal/questVars/factions/crime/map` | `true` | per-family M6 sharing; `false` = individual mode (stored per-player, never relayed) |
| `[sharing] regressAllowlist` | `[]` | quest ids allowed to move backwards; everything else is monotonic-max |
| `[rules] respawnCellKey/X/Y/Z` | `"village"`, `0,0,0` | where the respawn plugin sends the dead (placeholder demo coords) |
| `[rules] deathPenalty` | `"none"` | death-penalty plugin mode (`"none"` = no-op seed) |
| `[rules] pvp` | `false` | `false` → the pvp plugin drops player-targeted combat hits (actor targets unaffected) |
| `[rules] difficulty` | `0` | surfaced in `SessionWelcome.flags`; applied client-side by the victim |
| `[limits] maxHitDamage` | `1000` | sanity bound on relayed damage / effect magnitudes (not balance) |
| `[server] name` | `"openmw-mp"` | shown in `SessionHelloOk` and `/status` |
| `[server] motd` | `"Welcome to openmw-mp."` | sent in `SessionWelcome` + as a server chat line on join |
| `[server] maxPlayers` | `16` | sessions past Hello are counted |
| `[server] password` | `""` | non-empty: Register/Login must carry a matching `serverPassword` |
| `[login] allowRegistration` | `true` | `false` refuses `SessionRegister` |
| `[login] inviteCode` | `""` | non-empty: `SessionRegister` must carry a matching `inviteCode` |
| `[login] resumeWindowSec` | `300` | reserved for M1 session resume |
| `[content] enforce` | `"names"` | `"names"` \| `"strict"` (M0: stub, behaves like names) \| `"off"` |
| `[engine] enforce` | `"warn"` | engineHash mismatch: `"warn"` logs, `"refuse"` -> `BAD_ENGINE`, `"off"` skips |
| `[limits] msgsPerSec` | `60` | per-session message token bucket (burst = one second) |
| `[limits] moveMsgsPerSec` | `40` | separate budget for the player's own `PlayerMove` frames; over it, frames are dropped (not a kick) |
| `[limits] actorMoveMsgsPerSec` | `60` | own budget for the cell authority holder's `ActorMoveBatch` stream; over it, frames are dropped |
| `[limits] bytesPerSec` | `65536` | per-session byte token bucket |
| `[limits] maxBufferedBytes` | `262144` | outbound queue soft limit; over it, movement/actor frames to that client are dropped |
| `[limits] maxBufferedBytesHard` | `1048576` | outbound queue hard ceiling; over it the session is disconnected (`RATE`) |
| `[limits] maxConnsPerIp` | `3` | further connections refused (`RATE`) |
| `[limits] maxMsgBytes` | `262144` | ws `maxPayload` |
| `[limits] helloTimeoutMs` | `45000` | `SessionHello` deadline (generous: the client can only send it on a Lua tick, which stalls while the engine streams/loads a retail world) |
| `[limits] loginPerMinPerIp` | `5` | auth attempts per IP per minute |
| `[moderation] chatLog` | `true` | write chat + slash commands to `logs/chat-YYYY-MM-DD.jsonl` |
| `[moderation] retentionDays` | `14` | days of chat logs and reports kept (pruned at boot and on day rollover) |
| `[moderation] contextLines` | `20` | recent chat lines attached to each `/report` |

Moderation commands: `/report <player> <reason>` (any player) files a report with the
target's current cell and the last `contextLines` chat lines; `/reports [n]` and
`/chatlog <player> [minutes]` are rank 1 (moderator) and go through the same
`Admin.exec` gate as every other operator command, so the chat and `AdminCommand` event
paths cannot diverge. Chat logs and reports are **personal data** — see
[PRIVACY.md](PRIVACY.md).

Content policy in M0 (`names`): the server has no game data, so the **first** player's
manifest becomes the session's canonical manifest (exact name+size+order); it is dropped
once no session that passed the check remains connected. The engine-hash check uses the
same adopt-first rule.

## Single sign-on (optional)

SSO runs **alongside** account+password — a self-hoster who ignores `[auth]` sees no
change (`allowPasswordLogin = true` by default). Flow: OAuth 2.0 **Authorization Code +
PKCE (S256)**, with the code→token exchange done **on this server** holding the client
secret (a Backend-For-Frontend). The provider's access/refresh/ID tokens never reach the
browser; all it ever gets is a one-time, 60-second login ticket. Accounts are keyed on
`(issuer, subject)`, never on email — email is mutable and providers re-assign it — and no
email scope is requested.

To enable a provider, register an application with it, set the redirect URI to
`https://<your-host>/auth/<provider>/callback` **byte for byte**, and fill in:

```toml
[auth]
allowPasswordLogin = true
returnUrl = "https://<your-game-page>/"   # required as soon as any provider is enabled

[auth.google]
enabled = true
clientId = "…apps.googleusercontent.com"
clientSecret = "…"                         # Google web clients always have one
redirectUri = "https://<your-host>/auth/google/callback"
```

| Provider | Where to register | Notes |
| --- | --- | --- |
| `discord` | discord.com/developers/applications → OAuth2 → Redirects | OAuth 2.0, **not** OIDC: identity comes from `GET /users/@me` over the access token, scope `identify` |
| `google` | console.cloud.google.com/apis/credentials → OAuth client, type **Web** | OIDC discovery; scope `openid profile` |
| `microsoft` | entra.microsoft.com → App registrations → Authentication → **Web** | OIDC discovery via the `/common` endpoint; the per-tenant issuer is validated against the templated one |
| `custom` | any OIDC issuer (Keycloak, Authentik, Auth0…) | `issuer` is **required** and must serve `/.well-known/openid-configuration` |

The callback sends the browser back to `returnUrl` with the result in the URL **fragment**
(`#mpticket=…`, `#mperror=<code>`, `#mplink=<provider>`) — a fragment is never logged,
cached, or sent in a `Referer`. A `return` parameter from the caller is ignored on purpose:
this server is not an open redirector. Players can add further providers to one account via
`/auth/link/:provider?session=<sessionToken>`; an identity already owned by someone else is
refused. Linked identities are **personal data** — see [PRIVACY.md](PRIVACY.md).

## Trust model (read this before opening the port)

Clients run the simulation; the server only relays, bounds-checks sizes/rates, and
enforces session rules. A modified client can lie about anything gameplay-related —
position, stats, inventory, combat outcomes — and the server cannot detect it, because
it has no game data and no simulation to check against. The design target is
**password-gated co-op with people you trust**, not anonymous public play. Keep
`[server] password` set for anything internet-facing, and treat `/kick` + `banned` as
social tools, not security boundaries.

## Measured capacity

`npm run soak -- --bots 24 --minutes 30 --cells 6` (protocol-level bots: movement at the real
15 Hz, chat, cell hops that thrash cell authority, object spawns, combat, journal writes,
record creation, contended rest requests):

- **RSS 168 → 78 MB** over 30 min — the half-run means fall (126 → 77 MB), i.e. memory settles
  rather than creeping. 24 concurrent players sit well inside the 384 MB compose limit.
- 24/24 sessions alive throughout, zero unexpected drops; ping mean 4 ms, max 85 ms.
- Correctness held under that load, not just stability: journal stages stayed monotonic
  (129/129) while every bot raced the same quest and injected stale writes; 98 record ids were
  issued with no collisions; with PvP off, no player-targeted hit was ever delivered.

The soak fails the run on leak, drop, latency, session-count mismatch, or any of those
invariants — it is a gate, not a benchmark.

## VPS headroom

Measured 2026-07-19 on the shared OVH box (before openmw-mp existed):

- **RAM 23 GB total, ~21.5 GB available** (all co-tenants together used < 2 GB: the
  nl-* stack, edge-caddy, morrowind, ja2, freecad, www — heaviest single container was
  postgres at ~162 MB).
- 8 cores, all containers ~idle; 133 GB free disk (32% used).

The compose `mem_limit: 384m` + in-process 256 MB heap cap are therefore extremely
conservative on this box; `[server] maxPlayers` is the relief valve if that ever changes.
Re-measure with `free -m` + `docker stats --no-stream` before raising limits.

## Backups

Nightly cron on the VPS (installed manually, one-time — same convention as other /opt
services). SIGUSR1 makes the server flush all dirty state to disk first:

```sh
# /etc/cron.d/openmw-mp-backup (as root)
15 4 * * * root docker kill -s USR1 openmw-mp && sleep 2 \
  && tar czf /opt/openmw-mp/backups/data-$(date +\%F).tar.gz -C /opt/openmw-mp data \
  && find /opt/openmw-mp/backups -name 'data-*.tar.gz' -mtime +14 -delete
```

Restore: stop the container, untar over `/opt/openmw-mp/data`, `docker compose up -d`.
The deploy workflow never touches `/opt/openmw-mp/data`, so redeploys are always safe.

### Verifying the backup actually restores

Configuring a backup and knowing it restores are two different exercises. Having a cron
line is not evidence; a completed round trip is. `scripts/restore-drill.sh` is that
evidence:

```sh
server/scripts/restore-drill.sh          # ~15 s; --keep leaves the scratch dir for inspection
```

It boots a server on an ephemeral port and a scratch data dir, drives a **real** omw-mp/1
client to create an account plus a known character (appearance, cell, coordinates) and a
chat line, flushes with `SIGUSR1`, takes a `tar czf` backup **exactly the way the cron
above does**, deletes the data dir, restores from the tarball, boots again, and then
**asserts** the state came back: the account logs in, `SessionWelcome.playerRecord` carries
the same appearance and position, and the chat log still contains the seeded line. Any
mismatch exits nonzero with a reason, so it can gate CI — it never prints "probably fine".

Run it after any change to the persistence layer, the flush path, or the backup command
itself. If it fails, the nightly cron is not a backup, it is a tarball.

## Deploys and connected players

`.github/workflows/deploy-mp.yml` drains before it swaps: the running container is stopped
with `docker compose stop -t 29`, which sends `SIGTERM` and lets the server broadcast
`SessionDisconnect SHUTDOWN` to every session and flush all state within the compose
`stop_grace_period` (30 s). Players see a shutdown notice and reconnect, rather than having
the socket vanish mid-session.

**Known limitation — a deploy invalidates every resume ticket.** Session resume tickets live
in memory only (`src/core/resume.ts`, `[login] resumeWindowSec`), so they do not survive the
process. After a deploy every player pays a full re-login (argon2id, chargen-skip handshake,
world re-sync) instead of rejoining in place. That is acceptable for one server with a short
deploy window, and it is **not** acceptable for the persistent-worlds plan: multiple servers,
or a server that redeploys during peak, need tickets in shared durable storage (a small
signed-ticket file or a shared store keyed by account, expiring on the same window) so a
restart or a hand-off is invisible to the player. Nothing else in the resume path assumes
in-memory storage — `ResumeStore` is the only thing that would change.
