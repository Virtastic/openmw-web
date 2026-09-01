# Self-hosting openmw-web

## Quick start

The whole server, set up from a browser. You need
[Docker](https://docs.docker.com/get-started/get-docker/) and your own copy of Morrowind:

```bash
git clone https://github.com/Virtastic/openmw-web.git
cd openmw-web
./setup.sh        # Windows: .\setup.ps1
```

1. Unzip the latest `openmw-web-*.zip` from
   [Releases](https://github.com/Virtastic/openmw-web/releases) into `play/` (the engine is
   too big for git; the script reminds you if it is missing).
2. Your browser opens **http://localhost/admin**: create the admin account, answer the
   wizard, drag your `Data Files` folder in when it asks.
3. Play at **http://localhost**.

That's it. Stuck, or a question this page doesn't answer? Ask in
[Discord](https://discord.gg/PzFfDkbSue).

Useful afterwards:

```bash
./setup.sh --update    # pull a newer version and restart
./setup.sh --stop      # stop everything; your data is kept
```

Worth knowing:

- **Multiplayer is experimental and off by default.** The wizard shows it greyed out; start
  with `OMW_EXPERIMENTAL=multiplayer docker compose up -d` (or a `.env` file) to unlock it.
- **The server supplies the game files** to everyone who plays on it - you upload your
  `Data Files` once, in the wizard. Everyone playing still needs to own the game.
- **The address can move when you answer the hosting question.** A fresh server is plain
  HTTP; choose *Public* with a domain and it switches to HTTPS with a real certificate,
  fetched automatically. The page hands you to the new address itself.
- **A fresh install shows "unhealthy" in `docker compose ps`** until game data is in. That is
  expected - the dashboard is up and tells you what is missing.
- **Setting up from another machine** (a VPS over the internet) asks for a **setup key**,
  printed in the server log at startup - so a stranger cannot claim `/admin` first. From your
  own machine or LAN you are never asked.
- **Locked out?** `docker compose run --rm openmw-web node dist/server.mjs --data /data
  --admin-reset <name>` clears the password and two-factor and prints a temporary one.

## The dashboard, page by page

Each page needs a role: **viewer** reads, **moderator** acts on players, **owner** changes
the server. Pages a role cannot use are not shown to it.

| Page | Role | What it is for |
| --- | --- | --- |
| **Overview** | viewer | Uptime, who is on, memory, health |
| **Players & commands** | moderator | Roster, chat, reports, commands. Multiplayer only |
| **Mod manager** | viewer reads, owner changes | Install, order and remove mods (below) |
| **Game files** | viewer reads, owner changes | The base game's files and the upload checklist |
| **Core / Access / Storage / Operations** | viewer reads, owner changes | Every setting, with plain-language help |
| **Accounts** | moderator; owner for roles, deletion, saves | Who exists, their role, their savegames |
| **Admin sessions** | owner | Signed-in dashboard sessions, revocable |
| **My security** | viewer | Your own password and two-factor |
| **Logs / Audit trail** | moderator | What the server did; what administrators did |
| **Updates** | owner | Whether a newer release exists |
| **Maintenance** | owner | Close the doors before big changes. Multiplayer only |
| **Backup** | owner | Download the data folder as `tar.gz`. Restoring is stop, replace, start |
| **Restart** | owner | Restart the server |

Two cautions: **a backup contains secrets** (password hashes, S3 keys - treat the file like a
password), and **`[admin] dashboardToken` is a standing moderator credential** that bypasses
accounts and two-factor; prefer a real account with a role.

The setup wizard is first-run only. Change individual answers under Configuration instead of
re-running it.

### Mods

The Mod manager installs mods from an archive - drop a `.zip` or `.7z` on the page. The
server reads what is inside and shows the data folders it found; you tick the ones you want,
because Nexus downloads routinely bundle a core install with optional extras. (RAR is not
supported; re-save it as `.zip` or `.7z`.)

Each mod gets its own folder and a card in the load-order list:

- **Drag to reorder** (or use the arrows). Order is file priority: when two mods contain the
  same file, the one further down wins - and the badges saying "replaces N" / "N overridden"
  follow the list live as you drag.
- **The switch** takes a mod out of the load order without deleting it.
- **Details** shows what came from where, overlap explanations, and a checkbox per plugin.
- **Remove** deletes the mod's folder. Saves are untouched.

A plugin whose master is not loaded is flagged in red - that one aborts the game at startup,
so fix it before playing. Restart the server after changing mods; the dashboard offers to.

Installs show a real progress bar. A big `.7z` (Tamriel Data is 54,000 files) takes a few
minutes; Back and Skip are disabled while it runs.

### Tamriel Rebuilt

Choose Tamriel Rebuilt on the wizard's content step and it asks for the archives on a step
of its own, after the base game. It is **two** downloads and both are needed:

| Archive | What it is |
| --- | --- |
| Tamriel Rebuilt | The landmass (`TR_Mainland.esm` and friends) |
| Tamriel Data | The meshes, textures and sounds it draws from |

Upload each **as you downloaded it**, without unpacking - the release is recognised by the
file's hash, since release names vary. An unrecognised (newer) release installs the same and
just says it cannot name the version. Parts come ticked except anything that *removes*
vanilla content (TR ships one of those); forgetting the Tamriel Data half is flagged by name
rather than turning into a continent of error markers.

Tamriel Rebuilt is why the engine is 64-bit (wasm64): players need a browser with MEMORY64
support and the RAM to match.

### Savegames

Open an account under **Accounts** to see its saves. A moderator can see the list;
downloading or importing a save is owner-only. It exists so "my save is gone" never needs
shell access.

## Multiplayer server

Multiplayer is a real addition to a single-player game - expect rough edges. Unlock it with
`OMW_EXPERIMENTAL=multiplayer` and the wizard walks you through the rest. Three things to
know:

1. **The server simulates the world itself** (a headless copy of the engine runs NPCs, so a
   modified client cannot author what an NPC did). That is why it must have its own game
   data.
2. **One origin.** The game page and the server share a hostname; a separate
   `mp.example.com` cannot work. The Docker stack handles this for you.
3. **Sign-in is your choice** - SSO (Google / Discord / Microsoft), passwords, or both. The
   wizard collects the keys; creating the OAuth app at the provider is the one thing it
   cannot do for you, and [`docs/MULTIPLAYER-SETUP.md`](docs/MULTIPLAYER-SETUP.md) walks
   through it in about five minutes (plus optional S3 storage).

Running without Docker, wiring your own reverse proxy, capacity planning, moderation ranks
and the ops details live in [`docs/ADVANCED.md`](docs/ADVANCED.md).

## Static hosting without the dashboard

The release zip is also a self-contained static bundle: unzip it anywhere and run
`python3 server.py` (or double-click `Start openmw-web`). No accounts, no dashboard, no
mod manager - but playable in a minute, and players can point it at their own `Data Files`.

To serve your own Morrowind with it, copy your `Data Files` contents into `mwdata/` next to
`server.py` and run with `OPENMW_LAUNCHER=0`. Files stream on demand over HTTP range
requests; nothing is repacked.

Serving it with your own web server instead? The engine needs **cross-origin isolation** on
every response, over HTTPS (or localhost):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin
```

Plus `application/wasm` for `.wasm`, range-request support, and (nice to have) serving the
precompressed `.br` siblings. Caddy:

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

nginx and static hosts (Netlify, Cloudflare Pages) work the same way - set those three
headers in the host's config. Static hosts cannot run the multiplayer server.

## Browser support

Desktop Chrome or Chromium, with MEMORY64 (Chrome/Edge 133+). Firefox, Safari and mobile are
not supported.

## Licensing notes for hosts

The bundle is GPLv3 (see `LICENSE`, `NOTICE`, `THIRD-PARTY-LICENSES.md`). If you host it,
link to the source (this repository or the matching `openmw-web-src-<tag>.tar.gz`) somewhere
reasonable - the included pages already do this in their footers, so leaving them intact is
enough. The demo world is freely-licensed content (see `CREDITS-DEMO-DATA.txt`).

**Morrowind game data is not included and must never be bundled by hosts.** A server
supplies its operator's *own legally-owned* copy to its players, exactly as a player points
the browser at their own `Data Files`; everyone playing still needs to own the game. The
releases and deploy workflows ship no game data, and per-player uploads through the game
launcher stay private to each account, gated by a manifest so the locker stays a backup for
recognised game files rather than general file hosting. The full reasoning is in
[`docs/LEGAL.md`](docs/LEGAL.md).

---
WASM port © 2025–2026 [Virtastic](https://virtastic.app) - GPL-3.0-or-later
