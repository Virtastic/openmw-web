<!-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app
     SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web -->
# Advanced hosting

Everything here is for operators going beyond the Docker quick start in
[`../SELF_HOSTING.md`](../SELF_HOSTING.md): running without Docker, wiring your own proxy,
tuning a public gateway. Most people never need this page. Stuck, or something not covered?
Ask in [Discord](https://discord.gg/PzFfDkbSue).

## Running without Docker

The same server, set up by hand.

**1. Build.**

```bash
cd server
npm ci
npm run build     # emits dist/server.mjs (single world) and dist/gateway.mjs (gateway)
```

**2. Stage game data.** Copy your own `Data Files` into `<dataDir>/gamedata`. A multiplayer
server refuses to boot without it - deliberate, not a bug. The sim-peer binary is auto-probed
from `/usr/local/bin/openmw`, `/usr/bin/openmw` or `/opt/openmw/bin/openmw` (override with
`[simPeer] binary`); the production image below includes one.

**3. Generate the vanilla manifest** (until it exists the locker refuses every upload - the
safe default):

```bash
node server/tools/gen-vanilla-manifest.mjs "/path/to/Morrowind/Data Files" \
     --out <dataDir>/vanilla-manifest.json
```

**4. Write `<dataDir>/config.toml`.** Defaults live in `server/config.default.toml`,
documented inline; overrides deep-merge over them. Minimum viable:

```toml
[server]
password = "<long random string>"   # the SIM PEER's credential - never typed by a player.

[auth]
requireSso = true                   # SSO-only sign-in. Leave unset to also allow passwords.
returnUrl  = "https://example.com/launcher.html"

[auth.google]                       # and/or [auth.discord] / [auth.microsoft]
enabled      = true
clientId     = "..."
clientSecret = "..."
redirectUri  = "https://example.com/auth/google/callback"
```

Two silent footguns, both logged at boot: `requireSso` unset leaves password login open
beside SSO; behind Cloudflare, set `[limits] trustCloudflareIp = true` or every player shares
one rate-limit bucket. Storage is optional - with no S3 configured, lockers and saves land on
the server's disk (set `[locker] publicBase` to the origin players reach it on; provider-side
steps in [`MULTIPLAYER-SETUP.md`](MULTIPLAYER-SETUP.md)).

**5. Run.**

```bash
node dist/server.mjs --data ./devdata --port 8080                                # one world
node dist/gateway.mjs --worlds /data/worlds --shared /data --port 8080 --base-port 9000
docker compose -f server/docker-compose.prod.yml up -d                           # or the image
```

S3 keys go in the environment / an `env_file`, never in `config.toml`.

**6. Reverse-proxy, same origin as the game page.** The page will not hand its session
ticket to a different hostname. Forward to the gateway:

```
/w/*   /ws          # the gameplay WebSocket - needs Upgrade handling
/auth/*             # OAuth sign-in
/locker/*           # game-data upload/stream
/saves  /saves/*
/worlds /worlds/*
```

[`../deploy/Caddyfile`](../deploy/Caddyfile) is a working reference. Non-negotiables it
encodes: **strip `CF-Connecting-IP`, `X-Omw-Client-IP` and `True-Client-IP` from client
requests** (a forged one grants a fresh login budget and walks past IP bans), preserve
`X-Forwarded-Proto`, keep the COOP/COEP/CORP isolation headers on the game page, and never
expose `/admin`, `/metrics`, `/healthz` or `/status` to the internet.

**7. Verify.**

```bash
curl -s localhost:8080/healthz
curl -s localhost:8080/auth/providers
curl -s localhost:8080/worlds
```

## Configuration knobs you will actually touch

| Key | What |
|---|---|
| `[server] name`, `motd`, `maxPlayers` | identity and capacity |
| `[server] password` | **the sim peer's credential**, not a player password |
| `[auth] requireSso`, `[auth.google/discord/microsoft]` | sign-in |
| `[locker] *` | storage: S3 endpoint/bucket, or `publicBase` for disk mode; save quota |
| `[login] allowRegistration`, `inviteCode`, `resumeWindowSec` | who may join; rejoin window |
| `[content] enforce`, `[engine] enforce` | load-order / engine matching |
| `[sharing] *`, `[rules] *` | what is shared, and gameplay policy |
| `[admin] owners`, `allowConsole` | moderation |
| `[cellReset]`, `[limits]`, `[simPeer]`, `[dev] bots` | wipes, rate limits, the peer, test bots |

## Operating a multiplayer server

Ranks per account: **0** player, **1** moderator (`/kick /tp /tpto`), **2** admin
(`/ban /unban /give /motd`), **3** owner (`/setrank /console`). List your account in
`[admin] owners` and restart - promoted on boot, no hand-editing. Every action is logged as
`admin.action`. `/console` executes a script on a player's own client: owner-only, fully
logged, and `[admin] allowConsole = false` removes it entirely.

**Endpoints.** `GET /healthz` liveness; `GET /status` the launcher-facing summary (no IPs, no
account data); `GET /metrics` Prometheus, gated on `[metrics] token`, 404 while disabled.
`SIGUSR1` flushes state; `SIGTERM`/`SIGINT` disconnect cleanly and flush.

**Development bots.** `[dev] bots = N` (or `OMW_DEV_BOTS`, capped 16) spawns bots that hold
real accounts and handles for testing menus and social flows alone. The server says loudly at
boot when they run. Never on a server strangers can reach.

**Privacy.** Everything the server stores about players, and how to erase it, is in
[`../server/PRIVACY.md`](../server/PRIVACY.md) - including `--delete-account <name>`. Read it
before taking sign-ins from anyone but yourself.

## The sim-peer image

The production image (`server/Dockerfile.simpeer`, target `tier2`) compiles OpenMW from
source:

```bash
docker build --build-arg BUILD_JOBS=6 -f server/Dockerfile.simpeer -t openmw-simpeer .
```

**`BUILD_JOBS` ≈ one per gigabyte of spare RAM.** OpenMW translation units reach 1–2 GB
each; ninja's default on a many-core box exhausts memory and presents as a *hang*, not an
OOM kill.

## Sizing a gateway

**Every occupied world costs a sim peer** - worlds multiply the cost. Measured (Linux
x86-64, full retail data, one player): peer 487 MB + world 136 MB ≈ **640 MB per occupied
world**. Re-measure on your hardware with `server/scripts/measure-capacity.ts`.

The ceiling lives on the gateway:

```toml
[worlds]
memBudgetMb = 8192      # total RAM for worlds and their peers
worldCostMb = 640       # measured cost of one occupied world
gatewayReserveMb = 256  # held back for the gateway itself
```

`GET /healthz` reports the live ceiling; a refused player is told the server is full.
**`memBudgetMb = 0` disables the memory governor entirely** - the combination that gets a
container OOM-killed while every per-world cap reads as satisfied. Keep
`memBudgetMb + gatewayReserveMb` at or below the container's own limit.

**Rolling restart: `kill -HUP` the gateway.** Worlds restart one at a time, emptiest first,
each drained and verified back before the next - a world-code deploy is not an outage.
`--idle-reap-ms` (default 120000) controls how long a world may sit empty before
it is stopped; its data survives and it revives when its owner returns.
