# Self-hosting openmw-web

Grab `openmw-web-<tag>.zip` from
[Releases](https://github.com/Virtastic/openmw-web/releases) — it contains the
prebuilt engine and everything below. No compiler needed.

## Quick start (local)

```bash
unzip openmw-web-*.zip -d openmw-web && cd openmw-web
python3 server.py          # http://localhost:8910 (override with PORT=…)
```

Open the URL in **desktop Chrome/Chromium**. The root (`/`) serves the
data-chooser launcher, same as the live site: players pick either the bundled
free demo world or their own legally-owned Morrowind data, streamed straight
from disk. Set `OPENMW_LAUNCHER=0` to skip the chooser and boot the game
directly at `/` instead.

## Serving your own Morrowind with the site

If you own Morrowind and want the game to *come with* your server — so players
open the page and start, with nothing to pick and nothing to upload — copy the
contents of your `Data Files` folder into a `mwdata/` folder next to
`server.py`:

```
openmw-web/
├── server.py
├── index.html
└── mwdata/
    ├── Morrowind.esm
    ├── Morrowind.bsa
    ├── Fonts/  Music/  Sound/  Splash/  Video/
    └── …plus Tribunal/Bloodmoon and any mods, if you have them
```

Then start the server with the chooser turned off, so `/` boots straight into
the game:

```bash
OPENMW_LAUNCHER=0 python3 server.py
```

(Leave it on if you'd rather players still got the choice — the chooser's own
"bring your own copy" option keeps working either way.)

The server lists whatever is actually in `mwdata/` and the page loads exactly
that, so:

- **The base game on its own is enough.** Expansions are optional — nothing
  breaks if you don't own them.
- **Mods work.** Extra `.esm`/`.esp`/`.bsa` dropped in are picked up
  automatically (alphabetically; `?nomods=1` plays vanilla). A precise custom
  load order still needs a desktop mod manager.
- **Nothing is repacked.** Copy the folder as-is; there are no archives to
  build. Files are read in chunks over HTTP Range as the engine needs them, so
  the browser never downloads the whole 1.5 GB up front.

Your server needs **Range request** support for this (`server.py` has it; the
nginx and Caddy configs below are fine as written).

> **Do not put Morrowind data in a public release or a public web root you don't
> control.** You may serve your own copy to yourself; redistributing Bethesda's
> game data is a different thing entirely. See *Licensing notes for hosts*.

## The serving contract

The engine is multi-threaded WASM, which requires **cross-origin isolation**.
Your server must send these headers on **every** response:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin
```

Plus:

- **HTTPS** (or `http://localhost`) — isolation is only granted on secure origins.
- `application/wasm` MIME type for `.wasm`.
- Serve the precompressed `.br` siblings with `Content-Encoding: br` when the
  client accepts brotli — this turns the ~42 MB wasm into ~11 MB and the demo
  data into ~34 MB over the wire. (`server.py` does this automatically.)
- Support **Range requests** on `openmw.data` (used by the streaming loader).
- Long cache lifetimes are safe on `openmw.{js,wasm,data}` — purge or rename on
  redeploy.

### nginx

```nginx
server {
    listen 443 ssl http2;
    root /srv/openmw-web;
    types { application/wasm wasm; }

    add_header Cross-Origin-Opener-Policy   same-origin   always;
    add_header Cross-Origin-Embedder-Policy require-corp  always;
    add_header Cross-Origin-Resource-Policy cross-origin  always;

    brotli_static on;   # serve the .br siblings (ngx_brotli)
}
```

### Caddy

```caddy
example.com {
    root * /srv/openmw-web
    header {
        Cross-Origin-Opener-Policy   same-origin
        Cross-Origin-Embedder-Policy require-corp
        Cross-Origin-Resource-Policy cross-origin
    }
    file_server {
        precompressed br
    }
}
```

Static hosts (Netlify, Cloudflare Pages, …) work too — set the same three
headers in the host's headers config.

## Multiplayer server

Multiplayer (`server/`, Node 22) is optional — single-player hosting needs none of this.
Since 1.1.0 it is not a bare relay any more but a small platform: a **gateway** process
fronts many **world** processes (one shared public world, plus private/party worlds booted
on demand and reaped when idle), and every world runs a **sim peer** — a headless copy of
the OpenMW engine that simulates NPCs server-side so a modified client cannot author the
world.

Three consequences an operator must know up front:

1. **The sim peer is mandatory.** The server refuses to boot without a usable `openmw`
   binary and game data. That means **you supply your own legally-owned Morrowind
   `Data Files` on the server** (never bundled, never distributed — see the licensing
   notes below).
2. **One origin.** The game page and the server share a hostname. The page refuses to
   hand its session ticket to a server on a different host, so a separate
   `mp.example.com` cannot work — you reverse-proxy the server's paths from the same
   vhost that serves the game.
3. **Sign-in is OAuth** (Google / Discord / Microsoft). You need at least one OAuth app;
   [`docs/MULTIPLAYER-SETUP.md`](docs/MULTIPLAYER-SETUP.md) walks through creating one
   in about five minutes, plus the optional S3 storage locker.

### Step by step

**1. Build the server.**

```bash
cd server
npm ci
npm run build     # emits dist/server.mjs (single world) and dist/gateway.mjs (gateway)
```

**2. Stage game data for the sim peer.** Copy the contents of your own `Data Files`
into `<dataDir>/gamedata`. Without it the server refuses to boot — that is deliberate,
not a bug. The peer binary is auto-probed from `/usr/local/bin/openmw`,
`/usr/bin/openmw`, or `/opt/openmw/bin/openmw` (override with `[simPeer] binary`); the
shipped production image (`server/Dockerfile.simpeer`, target `tier2`) builds and
includes it.

**3. Generate the vanilla manifest** so the locker accepts player uploads (generated
from your own copy; until it exists the locker refuses every upload, which is the safe
default):

```bash
node server/tools/gen-vanilla-manifest.mjs "/path/to/Morrowind/Data Files" \
     --out <dataDir>/vanilla-manifest.json
```

**4. Write `<dataDir>/config.toml`.** Defaults live in `server/config.default.toml`
(documented inline) and overrides deep-merge over them. Minimum viable:

```toml
[server]
password = "<long random string>"   # the SIM PEER's credential — never typed by a player.
                                    # Empty = the server refuses to boot.

[auth]
requireSso = true                   # forces password login off. Set it on anything public.
returnUrl  = "https://example.com/launcher.html"

[auth.google]                       # and/or [auth.discord] / [auth.microsoft]
enabled      = true
clientId     = "..."
clientSecret = "..."
redirectUri  = "https://example.com/auth/google/callback"
```

Two silent footguns, both logged at boot: leave `requireSso` unset and password login
stays open beside SSO (`frontdoor.password_login_open`); behind Cloudflare, set
`[limits] trustCloudflareIp = true` or every player shares one rate-limit bucket
(`net.client_ip_mode`). Storage is optional — with no S3 bucket configured, lockers and
saves land on the server's own disk (set `[locker] publicBase` to the origin players
reach the server on; see [`docs/MULTIPLAYER-SETUP.md`](docs/MULTIPLAYER-SETUP.md) §2).

**5. Run it.**

```bash
# single world (development / small private server)
node dist/server.mjs --data ./devdata --port 8080

# the full platform: gateway + on-demand worlds + sim peers
node dist/gateway.mjs --worlds /data/worlds --shared /data --port 8080 --base-port 9000
```

Or with Docker — one container runs the gateway, the worlds and the sim peers together:

```bash
docker compose -f server/docker-compose.prod.yml up -d
```

(S3 keys go in the environment / an `env_file`, never in `config.toml`.)

**6. Reverse-proxy, same origin as the game page.** Forward these paths to the gateway
and leave everything else on the static handler:

```
/w/*        # the gameplay WebSocket — needs Upgrade handling
/ws         # local-dev direct dial — same
/auth/*     # OAuth sign-in
/locker/*   # game-data upload/stream
/saves  /saves/*
/worlds /worlds/*
```

The shipped [`deploy/Caddyfile`](deploy/Caddyfile) is a working reference. Non-negotiables
it encodes: **strip `CF-Connecting-IP`, `X-Omw-Client-IP` and `True-Client-IP` from client
requests** (a forged header otherwise grants a fresh login budget and walks past IP bans),
preserve `X-Forwarded-Proto`, keep the COOP/COEP/CORP isolation headers on the game page,
and do **not** expose `/admin`, `/metrics`, `/healthz` or `/status` to the internet.

**7. Verify.**

```bash
curl -s localhost:8080/healthz          # gateway liveness
curl -s localhost:8080/auth/providers   # your providers, "allowPasswordLogin":false
curl -s localhost:8080/worlds           # the world directory
```

Then open the launcher in a browser: sign in, pick a handle, upload your Data Files
once, and enter a world. For a two-player local test, use two browser profiles (each is
one account). Players join through the launcher on your origin — there is no server
address to type and no `?mp=` URL to hand out.

### Configuration knobs you will actually touch

| Key | What |
|---|---|
| `[server] name`, `motd`, `maxPlayers` | identity and capacity |
| `[server] password` | **the sim peer's credential**, not a player password |
| `[auth] requireSso`, `[auth.google/discord/microsoft]` | sign-in |
| `[locker] *` | storage: S3 endpoint/bucket, or `publicBase` for disk mode; `maxSaveBytesPerAccount` |
| `[login] allowRegistration`, `inviteCode`, `resumeWindowSec` | who may join; dropped-session rejoin window |
| `[content] enforce`, `[engine] enforce` | load-order / engine-build matching (`names`, `strict`, `off`) |
| `[sharing] *` | which quest families are world-shared vs per-player |
| `[rules] pvp`, `pvpZone`, `difficulty`, `partyScaling`, `sayScope`, `timeSkip`, `respawn*` | gameplay policy |
| `[admin] owners`, `allowConsole`, `dashboardToken` | moderation (below) |
| `[cellReset] cells`, `intervalSec` | scheduled cell wipes |
| `[limits] *` | rate limits, per-IP caps, `trustCloudflareIp`, avatar render LOD |
| `[simPeer] *` | peer binary path, generated config dirs, start deadline |
| `[dev] bots` | development bots (below) |

### Operating it

Ranks are stored per account: **0** player, **1** moderator (`/kick /tp /tpto`), **2** admin
(`/ban /unban /give /motd`), **3** owner (`/setrank /console`). List your own account
in `[admin] owners` and restart — it is promoted on boot, so you never hand-edit account
files. Commands work as chat slash-commands and, for tooling, as the `AdminCommand`
protocol message; both go through the same rank gate, and every action is logged as
`admin.action` with actor, target and arguments.

`/console` sends a script to a player's own client to execute. Treat it as remote code
execution on someone else's machine: it is owner-only, every use is logged in full, and
`[admin] allowConsole = false` removes it entirely.

**Web admin dashboard.** A single-page dashboard lives at `/admin` (overview, report
inbox, kick / ban / mute / broadcast / cell-reset actions). It is gated on a bearer
token, `[admin] dashboardToken` — with the token empty the routes do not exist at all.
It lives on the world process, which never faces the internet directly; reach it over
loopback or an SSH tunnel, never a public proxy route.

**Endpoints and signals.** `GET /healthz` is liveness on both processes. `GET /status`
(world process) is the launcher-facing JSON summary — name, MOTD, players, policy flags,
uptime, version; no IP addresses, no account data. `GET /metrics` is Prometheus text,
gated on `[metrics] token`, answering 404 while disabled so it is invisible until turned
on. `SIGUSR1` flushes state to disk; `SIGTERM`/`SIGINT` disconnect players cleanly and
flush.

**Development bots.** `[dev] bots = N` (or the `OMW_DEV_BOTS` env var; capped at 16)
spawns bots that hold accounts and characters, accept friend and party invites, and
stand where players begin — useful for testing menus and party flows alone. They
register **real** accounts and reserve **real** handles, so the server says loudly at
boot when they are running (`devbots.enabled`). Do not run them on a public server.

Everything the server stores about players, and how to erase it, is documented in
[`server/PRIVACY.md`](server/PRIVACY.md) — including the `--delete-account <name>` CLI
for deletion requests. Read it before you take sign-ins from anyone but yourself.

## Browser support

Desktop Chrome/Chromium only (SharedArrayBuffer + WebGL2/ANGLE +
`EXT_clip_control` + File System Access API). Firefox/Safari/mobile are not
supported.

## Licensing notes for hosts

The bundle is GPLv3 (see `LICENSE`, `NOTICE`, `THIRD-PARTY-LICENSES.md`). If
you host it, link to the source (this repository or the matching
`openmw-web-src-<tag>.tar.gz`) somewhere reasonable — the included pages
already do this in their footers, so leaving them intact is enough. The demo
world is freely-licensed content (see `CREDITS-DEMO-DATA.txt`); Morrowind
game data is **not** included and must never be bundled by hosts either.

### Multiplayer servers and game data

Since 1.1.0 a multiplayer server **requires game data**: every world runs a simulation
peer — a headless OpenMW that simulates NPCs on the operator's machine so a modified
client cannot author NPC behaviour for everyone else — and the server refuses to boot
without a peer binary and usable game data. Two things follow, and neither changes the
licensing stance above:

- **Nothing is bundled.** The operator places *their own legally-owned* copy in
  `<dataDir>/gamedata`, exactly as a player points the browser at their own `Data Files`.
  Neither the releases nor the deploy workflows ship or touch any game data; distributing
  it with a server would be as wrong as bundling it with the client.
- **Player uploads stay private.** The cloud locker holds each account's own copy with no
  deduplication and serves it back only to that account. The manifest gate exists so the
  locker stays a backup locker for recognized game files, not general file hosting. The
  full reasoning is written down in [`docs/LEGAL.md`](docs/LEGAL.md).

The shipped production image (`server/Dockerfile.simpeer`, target `tier2`) includes the
peer binary; budget roughly 1 GB of memory per world with a peer (~360 MB RSS measured
per peer, plus the world process).

---
WASM port © 2025–2026 [Virtastic](https://virtastic.app) — GPL-3.0-or-later
