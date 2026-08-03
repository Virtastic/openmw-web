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

The multiplayer relay (`server/`) is a separate, optional process: a Node 22 WebSocket
server that validates and relays play between clients and persists the shared world. It is
not needed to host single-player.

### Run it

```bash
cd server
npm ci
npm run build
node dist/server.mjs --data ./devdata --port 8080
```

Or with Docker (`server/Dockerfile`, `server/docker-compose.prod.yml`):

```bash
docker compose -f server/docker-compose.prod.yml up -d
```

Behind a reverse proxy, `/ws` must be upgraded to a WebSocket and `/status` + `/healthz`
proxied as plain GETs. With Caddy:

```
mp.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Use `wss://` in production. The game client joins via
`index.html?mp=wss://mp.example.com/ws&name=<display-name>`, which is exactly the URL a
launcher hands out — so a working `/status` plus that URL is all a server list needs.

### Configuration

Defaults live in `server/config.default.toml` (documented inline); operator overrides go in
`<dataDir>/config.toml` and are deep-merged over them. The knobs you will actually touch:

| Key | What |
|---|---|
| `[server] name`, `motd`, `maxPlayers`, `password` | identity and the front door |
| `[login] allowRegistration`, `inviteCode`, `resumeWindowSec` | who may create an account; how long a dropped session may rejoin in place |
| `[content] enforce`, `[engine] enforce` | load-order / engine-build matching (`names`, `strict`, `off`) |
| `[sharing] *` | which quest families are world-shared vs per-player |
| `[rules] pvp`, `difficulty`, `respawn*` | gameplay policy |
| `[admin] owners`, `allowConsole` | who bootstraps as rank 3; whether `/console` exists at all |
| `[cellReset] cells`, `intervalSec` | scheduled cell wipes |
| `[limits] *` | rate limits and per-IP caps |

### Operating it

Ranks are stored per account: **0** player, **1** moderator (`/kick /tp /tpto`), **2** admin
(`/ban /unban /ipban /give /motd`), **3** owner (`/setrank /console`). List your own account
in `[admin] owners` and restart — it is promoted on boot, so you never hand-edit account
files. Commands work as chat slash-commands and, for launcher/tooling use, as the
`AdminCommand` protocol message; both go through the same rank gate, and every action is
logged as `admin.action` with actor, target and arguments.

`/console` sends a script to a player's own client to execute. Treat it as remote code
execution on someone else's machine: it is owner-only, every use is logged in full, and
`[admin] allowConsole = false` removes it entirely.

- `GET /healthz` → `ok` (liveness).
- `GET /status` → public JSON for launchers: server name, MOTD, player count and list,
  max players, content/engine policy, whether a password or invite is required, PvP flag,
  uptime, version. It contains no IP addresses and no account data.
- `SIGUSR1` flushes state to disk; `SIGTERM`/`SIGINT` disconnect players cleanly and flush.

Everything the server stores about players, and how to erase it, is documented in
`server/PRIVACY.md` — including the `--delete-account <name>` CLI for deletion requests.
Read it before you take registrations from anyone but yourself.

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

The multiplayer relay needs **no game data at all** — movement, chat, objects, quests,
combat and the social layer all work with nothing installed on the server. That is the
normal configuration and nothing below is required for it.

Game data on a *server* buys exactly one thing: the **simulation peer**, a headless OpenMW
that runs NPCs on the operator's machine instead of in a player's browser. It closes the
largest anti-cheat hole (a modified client can no longer author NPC behaviour for everyone
else) and lets the server validate content at join.

Two things follow, and neither is a change to the licensing stance above:

- **Nothing is bundled.** An operator who wants this places *their own legally-owned* copy
  in `<dataDir>/gamedata`, exactly as a player points the browser at their own `Data Files`.
  Distributing that data with the server would be as wrong as bundling it with the client.
- **Without it you lose nothing but the peer.** Multiplayer stays fully functional; NPCs are
  simulated by a player's client, which is how it has always worked.

What tier 2 additionally requires, and which the shipped deploy does **not** yet provide:
a `/opt/openmw-mp/gamedata:/data/gamedata:ro` mount, `mem_limit` raised from 384 MB to
around 1 GB per peer (measured ~360 MB RSS each), and a base image carrying an `openmw`
binary — the current image is `node:22-alpine` with no engine in it. Until those exist the
peer stays off in production regardless of what is in the folder.

---
WASM port © 2025–2026 [Virtastic](https://virtastic.app) — GPL-3.0-or-later
