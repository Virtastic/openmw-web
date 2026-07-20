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

Signals: `SIGTERM`/`SIGINT` = graceful shutdown (every session gets
`SessionDisconnect SHUTDOWN`, accounts are flushed); `SIGUSR1` = flush accounts now.

## Data dir layout

```
<dataDir>/
  config.toml            # optional operator overrides (deep-merged over config.default.toml)
  accounts/<name>.json   # one file per account (lower-cased name), written atomically
```

To seed an admin: register in-game, stop the server (or it flushes within 30 s), edit
the account JSON's `"rank"` to `1` and restart or relog. `"banned": true` blocks login.

## Config reference

Defaults live in [`config.default.toml`](config.default.toml); an operator
`<dataDir>/config.toml` overrides per-key (tables merge, scalars/arrays replace).
Note `plugins` is a top-level key — in an override file it must appear **before** any
`[table]` header.

| key | default | meaning |
|---|---|---|
| `plugins` | `["motd"]` | built-in plugins to load, in order |
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
| `[limits] moveMsgsPerSec` | `40` | separate budget for PlayerMove frames (M1); bypasses `msgsPerSec` |
| `[limits] bytesPerSec` | `65536` | per-session byte token bucket |
| `[limits] maxConnsPerIp` | `3` | further connections refused (`RATE`) |
| `[limits] maxMsgBytes` | `262144` | ws `maxPayload` |
| `[limits] helloTimeoutMs` | `10000` | `SessionHello` deadline |
| `[limits] loginPerMinPerIp` | `5` | auth attempts per IP per minute |

Content policy in M0 (`names`): the server has no game data, so the **first** player's
manifest becomes the session's canonical manifest (exact name+size+order); it is dropped
once no session that passed the check remains connected. The engine-hash check uses the
same adopt-first rule.

## Trust model (read this before opening the port)

Clients run the simulation; the server only relays, bounds-checks sizes/rates, and
enforces session rules. A modified client can lie about anything gameplay-related —
position, stats, inventory, combat outcomes — and the server cannot detect it, because
it has no game data and no simulation to check against. The design target is
**password-gated co-op with people you trust**, not anonymous public play. Keep
`[server] password` set for anything internet-facing, and treat `/kick` + `banned` as
social tools, not security boundaries.

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
