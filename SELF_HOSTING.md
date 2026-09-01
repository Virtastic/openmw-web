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
  automatically (alphabetically; `?nomods=1` plays vanilla). This path has no
  dashboard, so a precise custom load order means naming files to sort the way
  you want, or running the Docker stack below, which has a mod manager that
  installs archives and lets you order them by dragging.
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
   notes below). The one exception is a server nobody has configured yet: it starts in
   setup mode so you can reach the admin dashboard, and refuses players until the data
   is in place.
2. **One origin.** The game page and the server share a hostname. The page refuses to
   hand its session ticket to a server on a different host, so a separate
   `mp.example.com` cannot work — you reverse-proxy the server's paths from the same
   vhost that serves the game. The quick start below sets that up for you.
3. **Sign-in is OAuth** (Google / Discord / Microsoft) *or* a username and password —
   both work, and one account can use either. If you want OAuth,
   [`docs/MULTIPLAYER-SETUP.md`](docs/MULTIPLAYER-SETUP.md) walks through creating an app
   in about five minutes, plus the optional S3 storage locker.

### Quick start (recommended)

This stack runs **either** mode: the wizard's first question is single player or multiplayer,
and everything from here down to *The manual path* applies to both. Single-player hosting can
also be done with the static server at the top of this file, which needs no Docker and has no
dashboard.

One command, then everything else happens in a browser. You need
[Docker](https://docs.docker.com/get-started/get-docker/) and nothing else — no Node, no
compiler, no editing TOML by hand.

```bash
git clone https://github.com/Virtastic/openmw-web.git
cd openmw-web
./setup.sh          # Windows: .\setup.ps1
```

The script checks Docker is installed and running, works out whether you have
`docker compose` or the older `docker-compose`, warns you if something is already using
ports 80 or 443, builds the server, waits for it to report itself healthy, and then opens
the admin dashboard for you.

The first screen asks you to create an administrator account — a username and a password,
and nothing else. Everything from there happens in the browser.

There is one exception, and you will only meet it if you go looking for it. If you set the
server up from *outside* its own network — a VPS you are administering over the internet,
say — that screen also asks for a **setup key**, because otherwise the first stranger to
find `/admin` could claim the server. The key is printed in the log at startup and saved as
`setup-token` in the data folder, both of which need access to the machine. From your own
computer or your own LAN you are never asked. It stops working once the first administrator
exists either way.

After that a short wizard covers the rest: single-player or multiplayer, how players sign
in, who may register, which Morrowind content you are running, whether players bring their
own game files or you supply them, how the server is reached, where uploads are stored, and
the game files themselves. Every answer is written to configuration you can review and change
afterwards.

Two of those are worth knowing before you answer them:

- **How the server is reached** has two shapes. *Public* wants a domain pointed at this
  machine and ports 80 and 443 forwarded to it, and fetches a real certificate for you.
  *Internal or behind your own proxy* is plain HTTP on a port you pick, which is right for a
  home network, a LAN party, or your own reverse proxy or tunnel in front. The catch is a
  browser rule rather than ours: the engine needs shared memory, which browsers grant only on
  a secure origin. `http://localhost` counts as secure and `https://` anything counts, but
  plain `http://` to an IP or a machine name does not, and players reaching it that way are
  told the browser is unsupported. Internal mode is therefore right when you play on this
  machine, or when something in front of it provides HTTPS.
- **Which Morrowind content** decides what the file checklist demands, and choosing Tamriel
  Rebuilt adds a step of its own; see *Tamriel Rebuilt* below.

**The server starts before it is ready, on purpose.** With no Morrowind files it comes up,
serves the dashboard, refuses players with a clear reason, and reports itself unhealthy —
rather than exiting, which would leave you with a failure and no way to reach the page that
explains it. `docker compose ps` showing `unhealthy` on a fresh install is expected; the
dashboard tells you exactly what is missing.

**Copy your Morrowind files into `gamedata/`** next to `docker-compose.yml` — at minimum
`Morrowind.esm` and `Morrowind.bsa`, plus `Tribunal`/`Bloodmoon` if you own them. The
wizard shows you which files it found and which are missing. You can do this before or
after running the script; the server starts either way and tells you what it needs.

To serve the game client from the same host (which multiplayer requires), unpack a release
zip into `client/`. Caddy serves those files at `/` and hands everything else to the
server. Leave it empty to run server-only and point players at a client you host elsewhere.

Useful afterwards:

```bash
./setup.sh --update    # pull a newer version and restart
./setup.sh --stop      # stop everything; your data in ./data is kept
```

**HTTPS.** Answer the wizard's hosting question with your domain and a real certificate is
fetched automatically, usually within seconds — the dashboard writes the proxy's whole
configuration and the proxy reloads itself, so there is no file to edit and nothing to
restart. Without a domain it serves a
certificate it signed itself: still encrypted, but your browser warns on the first visit.
That warning is expected, and the dashboard says so rather than leaving you guessing.

**Locked out?** If you lose the only administrator password:

```bash
docker compose run --rm openmw-web node dist/server.mjs --data /data --admin-reset <name>
```

That clears the password and any two-factor on that account and prints a temporary one.

### Mods

The dashboard's **Game data and mods** page installs mods from an archive, so nothing has to
be unpacked into `gamedata/` by hand.

Drop a `.zip` or a `.7z` on the page, or pick one. The server reads what is inside without
extracting it and shows you the data folders it found, each with its plugins, its asset
archives and its file count. You tick the ones you want. This step exists because Nexus has no
packaging standard: one download routinely holds a core install, optional textures, and a
compatibility patch, and installing all of them because they arrived together is how a game
ends up broken a long way from the mod that broke it. RAR is not supported (the bundled p7zip
is built without the non-free codec); open it and save it as a `.zip` or `.7z`.

Each mod installs into its own folder under `gamedata/mods/`, and the page lists them in load
order:

- **Drag to reorder.** Order is file priority: when two mods contain the same file, the one
  further down the list provides the copy the game uses. The arrow buttons do the same thing
  for touch and keyboard.
- **The switch** takes a mod out of the load order without deleting it.
- **Details** opens what the archive was, what is in the mod, which files it overlaps with
  and which mod wins each of them, and a checkbox per plugin so you can keep a mod's assets
  while skipping one of its plugins.
- **Remove** deletes the folder and everything in it. Saves are untouched, but anything that
  depended on the mod will not load.

Two things are flagged rather than left for you to discover in the game. A mod that replaces
files another mod provides is marked with how many, on both mods, and the marks follow the
list as you drag it. A plugin whose master is not loaded is marked in red, and that one is not
a matter of taste: Morrowind aborts at startup when a master is missing, and the player sees a
black screen with no message.

Restart the server after changing mods; the dashboard offers to do it.

Archives may hold up to 100,000 files and the upload cap is 8 GB, which is headroom rather
than a target. Extraction of a very large `.7z` takes minutes and reports itself as
"Installing" throughout: the format has no random access, so the whole archive is unpacked
before the parts you chose are moved into place.

### Tamriel Rebuilt

[Tamriel Rebuilt](https://www.tamriel-rebuilt.org/) is not part of anyone's `Data Files`
folder, so it is not something the game-data upload can pick up. Choose it on the wizard's
content step and the wizard asks for it directly, on a step of its own after the base game.

It is **two** downloads and both are needed:

| Archive | What it is |
| --- | --- |
| Tamriel Rebuilt | The landmass: `TR_Mainland.esm`, plus optional Faction Integration and Firemoth Remover |
| Tamriel Data | The meshes, textures and sounds it draws from: `Tamriel_Data.esm` and its assets |

Upload each one **as you downloaded it**, without unpacking. The release is identified by the
SHA-256 of the archive rather than by its filename, because release names vary between
versions and browsers, chat clients and mod managers all rename downloads. A release the
server has not been told about installs exactly the same way and says only that it cannot put
a version number on it; the hash is printed on the page, which is what to send if you want it
recognised in a later build.

The optional parts are yours to tick. Firemoth Remover in particular removes a vanilla quest
island on purpose, which is not something to apply to a server because it happened to be in
the same archive.

`TR_Mainland.esm` names `Tamriel_Data.esm` as one of its masters, so forgetting the assets
half is reported by name on the step and on the mods page rather than turning into a continent
of error markers at runtime.

**Memory.** Tamriel Rebuilt is why the engine is built for wasm64: a 32-bit build cannot
address enough memory to hold that load order. Players need a browser with `MEMORY64` support
and a machine with the RAM to match.

### Savegames

Open an account from **Accounts** to see its saves with their sizes and dates. A moderator
can see that list; downloading a save as a file and importing one back are **owner** only,
because both move a player's data around. It exists so that "my save is gone" does not require
shell access to the storage backend. An import is checked against the account's quota, and the
file's size is read back from storage rather than trusted from the request.

### The manual path

Everything below sets the same thing up by hand. Use it if you want to run without Docker,
or you are integrating with infrastructure you already have.

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
peer binary. Building it compiles OpenMW from source:

```bash
docker build --build-arg BUILD_JOBS=6 -f server/Dockerfile.simpeer -t openmw-simpeer .
```

**Set `BUILD_JOBS` to roughly one per gigabyte of RAM you can spare.** OpenMW translation units
reach 1–2 GB each, and letting ninja use its default (`nproc + 2`) on a many-core machine with
ordinary memory exhausts RAM — where it presents as a *hang* rather than an OOM kill: the build
stops emitting output partway through and takes the Docker daemon with it. The default of 6 is
deliberately conservative.

### Sizing a gateway (read this before opening it to anyone)

**Every occupied world costs a sim peer.** Each world is its own process and each one runs its
own peer supervisor, so worlds *multiply* the peer's cost rather than sharing it.

Measured on Linux/x86-64 with full retail Morrowind + Tribunal + Bloodmoon, one player anchoring
one exterior cell, host load 1.4:

| | RSS |
| --- | --- |
| sim peer (headless OpenMW) | 487 MB |
| world process (node) | 136 MB |
| **one occupied world** | **623 MB** |
| gateway process (supervising one world) | 118 MB |

The peer reached `SessionHello` 11.4 s after spawn with that data set. Budget **~640 MB per
occupied world** and re-measure on your own hardware with your own game data —
`server/scripts/measure-capacity.ts` does it against a running stack, and a peer anchoring
several busy cells will cost more than one standing in Seyda Neen.

`[simPeer] maxPeers` cannot govern this: it is per world process and cannot see its siblings.
The ceiling that can is `[worlds]`, on the **gateway**:

```toml
[worlds]
memBudgetMb = 8192      # total RAM for worlds and their peers
worldCostMb = 640       # measured cost of one occupied world
gatewayReserveMb = 256  # held back for the gateway itself
```

That budget admits 12 concurrent occupied worlds; `GET /healthz` reports the live ceiling as
`{"capacity":12,"capacityReason":"memory"}`.

The gateway takes the lower of this and the count cap, logs which one binds
(`gateway.capacity` at boot), reports it on `GET /healthz`, and refuses a world with
`world.at_cap` naming the reason. A player who cannot get in is told the server is full rather
than being left to retry. `GET /metrics` on the gateway (same bearer as a world's) carries
`omwmp_worlds_running`, `omwmp_worlds_capacity` and `omwmp_world_refused_total`.

`--idle-reap-ms` overrides how long a non-public world may sit empty before it is stopped
(default 120000). Its data survives; the world is revived when its owner dials back in.

**Rolling restart: `kill -HUP` the gateway.** Worlds restart one at a time, emptiest first, and
the next is not touched until the previous one answers `/status` again — so a world-code deploy
is not an outage. Each world drains first (its players are told `SHUTDOWN` and the client waits
for it to come back rather than treating it as fatal), and a world that will not return halts
the rollout instead of turning one failure into a full one.

**Leave `memBudgetMb` at 0 and there is no memory governor at all** — only a count cap, which
defaults to `[server] maxPlayers`. That combination is how a container gets OOM-killed while
every per-world cap reads as satisfied. Keep `memBudgetMb + gatewayReserveMb` at or below the
container's own memory limit; raising one without the other only changes which of the two
kills you first.

---
WASM port © 2025–2026 [Virtastic](https://virtastic.app) — GPL-3.0-or-later
