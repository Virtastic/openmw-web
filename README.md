# openmw-web

**Play Morrowind in your browser.** The OpenMW engine, compiled to WebAssembly, by [Virtastic](https://virtastic.app).

<p align="center">
  <a href="https://morrowind.virtastic.app"><img src="docs/hero-seyda-neen.jpg" alt="Morrowind running in a desktop Chrome tab at morrowind.virtastic.app: the opening town of Seyda Neen, with the Census office, a silt strider, and the player on the dock" width="850"></a>
</p>

<p>
  <a href="https://morrowind.virtastic.app"><b>▶ Play now at morrowind.virtastic.app</b></a> ·
  <a href="https://discord.gg/PzFfDkbSue">Discord</a> ·
  <a href="https://www.youtube.com/@Virtastic-Apps">YouTube</a> ·
  <a href="https://github.com/Virtastic/openmw-web/releases">Releases</a> ·
  <a href="https://github.com/Virtastic/openmw-web/issues">Issues</a> ·
  <a href="https://github.com/Virtastic/openmw-web/discussions">Discussions</a>
</p>

[![Discord](https://img.shields.io/badge/Discord-join%20the%20server-5865F2?logo=discord&logoColor=white)](https://discord.gg/PzFfDkbSue)
![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPLv3-blue)
![Platform: Chrome desktop](https://img.shields.io/badge/browser-Chrome%20%2F%20Chromium-brightgreen)
[![Latest release](https://img.shields.io/github/v/release/Virtastic/openmw-web)](https://github.com/Virtastic/openmw-web/releases)

openmw-web is a WebAssembly build of the [OpenMW](https://openmw.org/) engine, the
open-source reimplementation of *The Elder Scrolls III: Morrowind*. It is
cross-compiled with Emscripten so the whole engine runs client-side in a desktop
browser. There are no plugins and no streaming service. The engine runs locally and
reads game data from your machine.

**New in 1.1.0: multiplayer.** Morrowind is a single-player game, so this is a real
addition rather than a port — a server that owns the shared world, and a client that
asks it what happened. Play solo, invite a party, or step into a public world with
strangers in it. See [Multiplayer](#multiplayer) below, and
[`docs/MULTIPLAYER-SETUP.md`](docs/MULTIPLAYER-SETUP.md) to run your own.

## Host your own server

One command, then a browser does the rest. No config files, no terminal steps after this:

```bash
git clone https://github.com/Virtastic/openmw-web.git
cd openmw-web
./setup.sh        # Windows: .\setup.ps1
```

The script checks Docker is installed (and points you at the installer if not), starts
the stack, and opens `https://localhost/admin` in your browser, where a setup wizard
walks you through everything: your admin account, single player or multiplayer, how
players sign in, which game files you have, and where the server lives on the network
(a public domain with a certificate fetched for you, or plain HTTP on a port you pick).
Every setting has plain-language help next to it.

Multiplayer is **experimental and off by default**: the wizard shows it greyed out, along
with serving the game files from the server and keeping player files in S3, and
`OMW_EXPERIMENTAL=multiplayer` (or `all`) turns them on. Single player needs nothing set.

Afterwards the dashboard is where the server is run. It installs **mods** from a `.zip`
or `.7z`, shows what each one overwrites, and lets you set the load order by dragging;
it has a setup path for **Tamriel Rebuilt**, which is a separate download in two
archives; and it can export and re-import a player's **savegames** without shell access.
See [`SELF_HOSTING.md`](SELF_HOSTING.md) for details, and re-run `./setup.sh --update`
whenever the dashboard tells you a new release is out.

The `openmw/` tree tracks upstream
[`OpenMW/openmw`](https://github.com/OpenMW/openmw) at commit
`bc1d9c97a3881bb961a0b74e6e49bbba772b86a1` (recorded in
[`.openmw-base-commit.txt`](.openmw-base-commit.txt)), plus local changes for the
WASM target: a GLES/WebGL2 shader port, threading and main-loop changes, GPU
skinning, and a streaming virtual filesystem, among others.
[`WASM_ADAPTATIONS.md`](WASM_ADAPTATIONS.md) is a writeup of how the native desktop
engine was made to run in a browser tab.

## Playing

Serve `play/` (see [Running](#running)) and open it in desktop Chrome. With the
launcher enabled there are four ways in:

- **The example world.** A small, freely-distributable demo that ships with OpenMW.
  No copy of Morrowind required.
- **Bring your own Morrowind.** Point the browser at your own `Data Files` folder
  from a legally-obtained install. Files are read straight from disk on demand via
  the File System Access API and streamed into the engine, so there is no
  multi-gigabyte upload or copy. The folder you pick is remembered for next time.
  On Windows, first copy that `Data Files` folder somewhere outside a protected
  system location, such as your Documents or Desktop folder: browsers refuse to open
  folders inside `Program Files`, and Steam's default library lives there. See
  [Troubleshooting](#troubleshooting) below.
- **This server's copy.** Shown only when the host has staged game data of its own. The
  files are read from the server as the world needs them, so there is nothing to install
  and no folder to pick.
- **Play your own Morrowind, from anywhere.** Sign in and upload your Morrowind once; it
  is then waiting on any machine you sign in from, and your saves go with it. Single
  player. This is the same account and the same storage locker multiplayer uses, so
  uploading for one covers the other.

[Multiplayer](#multiplayer) adds a fifth entry point and is **experimental**.

Settings and keybindings persist in the browser (IndexedDB) and survive reloads.
Saves persist too, and where they land depends on how you are playing:

- **Bring your own Morrowind** — written to an `openmw-web-saves` folder on disk
  inside the folder you picked (real files, via the File System Access API), so they
  survive clearing browser data and can be backed up like any other file.
- **Signed in to a server** — saved to the server as well, so a cleared browser or a
  different machine picks the same game back up. The upload happens when you click
  Save in the game and at no other time: there is no autosave and no background
  snapshotting.
- **The example world, offline** — browser storage (IndexedDB) only. Durable in
  practice, but the browser may evict it under storage pressure, so use the in-game
  backup if a run matters to you.

A themed loading screen shows real download and mount progress on the way in.

### Tuning for your GPU

In-game, **Options → Video** has a resolution-scale setting: Full, High (75%), Half,
Third, or Quarter. It renders the 3D scene at a fraction of native resolution and
upscales it, while the menus, HUD, and text stay crisp at full resolution. Drop it a
notch to trade sharpness for framerate on lighter hardware, or leave it at Full on a
fast GPU.

**Morrowind game data is not included or distributed here.** You need your own
legally-obtained copy to play the full game.

### Enabling the launcher

The launcher sits behind a flag so the bare game page stays the default. Enable it
for the dev server by copying the example env file:

```bash
cp play/.env.example play/.env      # sets OPENMW_LAUNCHER=1
```

With `OPENMW_LAUNCHER` set, the site root (`/`) serves the data chooser. Without it,
`/` boots straight into the game. On a production host, set the `OPENMW_LAUNCHER`
environment variable (or replicate the routing) however you prefer.

### Troubleshooting

**"Can't open this folder because it contains system files"** when you pick your Data
Files folder. The browser's File System Access API refuses folders inside protected
system locations, which on Windows includes `Program Files` and `Program Files (x86)`.
Steam's default library sits there (`C:\Program Files (x86)\Steam\steamapps\common\`),
so a default Steam install of Morrowind gets blocked. This is a Chromium behavior, so
it is identical in Chrome and Edge; switching browsers does not help. The fix is to
copy the `Data Files` folder to a normal location such as your Documents or Desktop
folder, or another drive, and point the picker there. GOG installs under `C:\GOG
Games\` are not affected.

**"Doesn't look like a Data Files folder."** Pick the folder that actually contains
`Morrowind.esm` and `Morrowind.bsa` (or pick the parent `Morrowind` folder and the
launcher finds `Data Files` inside it).

**No sound, music, or intro video.** Your copy is missing the loose `Sound`, `Music`,
or `Video` folders that live inside `Data Files` (they are not stored in the `.bsa`).
A normal Steam or GOG install has them.

## Multiplayer

**Experimental.** It works and is playable, but it is young: expect rough edges, and expect
behaviour to change.

Morrowind has no multiplayer, so none of this is a port of something upstream — it is a
server that owns the shared world and a client that asks it what happened.

**Three ways to play, switched from inside the game.** *Solo* is your own world, no one
else in it. *Party* puts your group in one world together. *Public* is a shared world
with strangers in it. Switching carries your character over and reloads into the new world,
so there is a loading screen — you are genuinely going somewhere else, and nothing from the
old world is left behind in the new one.

**The public world is a lobby, and nothing there is permanent.** It is where you meet people:
you arrive with your gear, play, and leave with exactly what you had — a sword found there does
not come home with you, and one lost there is still yours. Quests do not advance in it either.
Real progress happens in your own world, or in a friend's.

**Visiting a friend's world advances THEIR campaign.** You keep what you carry out and every
skill you used getting it — Morrowind levels what you actually do, so helping a friend is never
wasted — but the quest log is the host's. Your own story is neither moved nor spoiled by the
visit, and the game says so when you arrive.

**Your copy follows you.** Sign in and upload your Morrowind once; it streams back to you on
any machine you sign in from, and your saves go with it. Uploads are private to the account,
never shared between players, and checked against a manifest so unrelated files are refused
rather than stored.

There is a **cloud locker** tile for this on its own, without multiplayer: same account, same
uploaded files, single player. Upload once, play anywhere.

**The server decides.** NPCs, combat resolution, loot and cell state are simulated
server-side by a headless copy of the engine that holds authority over the cells players
are standing in. A modified client **cannot author what an NPC did, and cannot vouch for its
own damage against one** — those are the operator's machine's to decide, and a forged actor
update is rejected, counted and relayed to nobody.

Where it is bounded rather than impossible, this says so. Your own character's position and
stats are still reported by your own client, because that is what makes the game feel
responsive — so the server bounds them instead: impossible speed stops being relayed to other
players in the public world, and hopping across the map is rate-limited. Dropping an item you
do not have is detected everywhere and refusable, though operators must turn that on. Character
state (position, inventory, stats, journal, faction standing) lives in the server's own
per-character document, written behind a debounce and flushed on cell change, level-up
and logout.

**Sign-in is SSO only** — Google, Discord or Microsoft. There is no password to phish,
reuse or leak, because there is no password. Only `openid profile` is requested; the
email scope never is. Your public handle is a username you choose, never the provider's
name claim.

**You bring your own game data.** A player uploads their own Morrowind files once to a
private storage locker and streams them back on any device. Each account holds its own
copy with no deduplication between accounts, uploads are gated on an ownership
attestation and a per-file content check, and nothing is ever shared between players.
This is deliberate and the reasoning is written down in [`docs/LEGAL.md`](docs/LEGAL.md).

**Also there:** friends and presence, parties with loot rolls, whisper, mute and block,
in-game reporting with chat context for moderators, an admin surface, and server-side
savegames. Running your own server needs an OAuth app, your own copy of the game data
for the server-side simulation, and a spare half hour: the step-by-step is in
[`SELF_HOSTING.md`](SELF_HOSTING.md#multiplayer-server), with the OAuth and storage
details in [`docs/MULTIPLAYER-SETUP.md`](docs/MULTIPLAYER-SETUP.md). Storage is
optional — with no S3 bucket configured, lockers and saves go to a folder on the server.

For running the server on your own machine while developing, see
[Multiplayer locally](#multiplayer-locally).

## What's in this repo

This is a code-only repo. Large binaries (game assets, dependency source caches, and
build artifacts) are excluded via [`.gitignore`](.gitignore) and must be provided or
rebuilt locally.

| Path | Purpose |
|------|---------|
| `openmw/` | OpenMW engine source (upstream plus local WASM changes) |
| `configure-openmw.sh` | Emscripten/CMake configure step for the WASM build |
| `wasm-build/link-openmw.sh` | Canonical final link step (runtime flags plus preload FS) |
| `wasm-build/build-osg.sh` | OpenSceneGraph configure/build for WASM |
| `wasm-build/x11_stubs.c` | Signature-exact X11 no-op stubs that osgViewer links against |
| `wasm-build/patches/osg-emscripten.patch` | All OSG source fixes for WebGL2/emscripten |
| `play/` | Browser front-end: `launcher.html`, `index.html`, `openmw.js` loader, `server.py` dev server |
| `server/` | The multiplayer server (TypeScript, Node): world gateway, SSO, storage locker, savegames, and the authority model |
| `deploy/` | Container and reverse-proxy config for a real deployment |
| `fsroot/` | Virtual filesystem config and mount layout for the WASM runtime (the demo dataset itself, `fsroot/gamedata/`, is gitignored; see below) |

### Not included (kept local)

- `source-mw/`, `archive/`, `content/`, `fsroot/gamedata/`, `play/mwdata/`:
  copyrighted Morrowind game data.
- `deps/`: the cross-compiled dependency stack and its source tarballs (boost,
  bullet3, OSG, MyGUI, SDL2, and the rest).
- `build-wasm/` and all `*.wasm` / `*.data` build outputs.

## Self-hosting (grab and go)

You don't need to build anything to run your own instance. Every
[release](https://github.com/Virtastic/openmw-web/releases) ships two archives:

- **`openmw-web-<tag>.zip`** holds the prebuilt engine (`openmw.js/.wasm/.data` plus
  brotli variants), the web front-end, and a ready-to-run dev server. Unzip it and
  double-click `Start openmw-web` — it checks for Python, starts the server, and
  opens your browser. (`python3 server.py` still works.) See
  [`SELF_HOSTING.md`](SELF_HOSTING.md) for production servers.
- Own Morrowind and want it served *with* the site, so players have nothing to pick
  and nothing to upload? Copy your `Data Files` into a `mwdata/` folder next to
  `server.py` and run it with `OPENMW_LAUNCHER=0`. It loads whatever is actually
  there: base game alone, expansions, mods. (This path has no dashboard; the Docker
  stack above is the one with the mod manager.) See
  [`SELF_HOSTING.md`](SELF_HOSTING.md#serving-your-own-morrowind-with-the-site).
- **`openmw-web-src-<tag>.tar.gz`** is the exact source snapshot that built it (the
  GPLv3 Complete Corresponding Source).

See [`CHANGELOG.md`](CHANGELOG.md) for what changed in each release.

## Building

You will need **Emscripten 6.0.1** (Homebrew paths are assumed; adjust `EMSDK_BIN`),
CMake, and Ninja, plus the cross-compiled dependency stack under `deps/wasm` (not in
this repo; see [Dependency stack](#dependency-stack) below).

```bash
export ROOT=$PWD                      # repo root

# 1. Configure (compiles fine from CMake; the final LINK is done out-of-band in step 3)
./configure-openmw.sh

# 2. Compile everything
ninja -C build-wasm components openmw-lib

# 3. Link with the runtime flags (WebGL2, pthreads, preload FS, IDBFS...)
./wasm-build/link-openmw.sh

# 4. Deploy
cp build-wasm/openmw.js build-wasm/openmw.wasm build-wasm/openmw.data play/
```

### wasm64 (MEMORY64)

The engine can be built for **wasm64**, which lifts the heap ceiling above the 4 GiB a 32-bit
wasm module can address. That is what a Tamriel Rebuilt load order needs: the wasm32 build
already links `-sMAXIMUM_MEMORY=4294967296`, i.e. the entire 32-bit address space, so there is
no headroom left to give it.

Set `OMW_WASM64=1` for **every** step — the dependency stack, the configure and the link must
all agree:

```bash
export ROOT=$PWD OMW_WASM64=1

./wasm-build/build-deps.sh            # -> deps/wasm64  (see Dependency stack below)
./configure-openmw.sh
ninja -C build-wasm64 components openmw-lib
./wasm-build/link-openmw.sh
cp build-wasm64/openmw.{js,wasm,data} play/
```

Notes, all of them learned the hard way:

- The variable selects `deps/wasm64`, the `wasm64-emscripten` sysroot, `build-wasm64/` and the
  `-m64` flag. With it unset everything is byte-for-byte the wasm32 build, so switching back is
  unsetting a variable rather than reverting a commit.
- **`-m64`, not `-sMEMORY64=1`.** Emscripten 6.0.1 accepts both but warns the `-s` spelling is
  deprecated, and `-m64` is a compiler flag, so it reaches CMake's `try_compile` probes.
- The two models **cannot share a build tree or a dep prefix**. A wasm32 archive in a wasm64
  link fails with `wasm32 object file can't be linked in wasm64 mode` — loud, but only at the
  final link. `build-deps.sh` stamps each source tree with the model it was last built for and
  cleans when it changes.
- Browsers need memory64: Chrome/Edge 133+ or Firefox 134+. `play/index.html` and
  `play/launcher.html` feature-detect it and show the unsupported overlay otherwise.
- `wasm-build/memory64-gate.sh` is the standalone check that the toolchain, threads, the >4 GiB
  allocation and the JS pointer ABI all work, without building the engine. Run it first if
  anything looks wrong; `--wasm32` builds the same program as a control and `--browser` runs it
  in headless Chrome under COOP/COEP.

A few things to watch for, which are why the link step is scripted:

- `main.cpp.o` is passed directly on the link line. `ninja components openmw-lib`
  does not rebuild it; the script does.
- The whole stack uses `-fwasm-exceptions` (legacy wasm EH). Do not add `-flto`
  (wasm-ld crashes or miscompiles boot) or `-sWASM_LEGACY_EXCEPTIONS=0`.
- Hand-built deps must be compiled with `-pthread`. ICU uses the sysroot `-mt`
  variants.
- Killing the link mid-run leaves a mismatched `openmw.js`/`openmw.wasm` pair, so
  check that both mtimes match before deploying.

### Dependency stack

All deps are cross-compiled to static libs in `deps/wasm/lib`, with headers in
`deps/wasm/include` (`deps/wasm64/*` for the wasm64 build): OSG 3.6.5, Bullet (double-precision), MyGUI, FFmpeg 6 (bink video plus the
mp3/pcm/vorbis decoders game audio needs), Boost (program_options plus iostreams), Lua 5.4,
LZ4, and RecastNavigation. SDL2, FreeType, HarfBuzz, png, jpeg, zlib, ogg, and vorbis
come from emscripten ports at link time; OpenAL is emscripten's built-in.

`./wasm-build/build-deps.sh` builds the whole stack from source (one function per
dep, staging into `deps/wasm/{lib,include}`). Run it with no args to build
everything, or pass targets like `build-deps.sh bullet lua`. It wraps the standard
emscripten cross-compiles for Bullet, Recast, MyGUI, FFmpeg, Boost, Lua, LZ4, the
empty OpenAL stub, the ICU-mt and libGL-getprocaddr emscripten ports, and OSG.

**Building the stack in Docker.** `build-deps.sh` assumes a host emsdk; the pinned toolchain
image works too and needs two things the image does not ship:

```bash
docker run --rm -i -v "$PWD:/repo" -w /repo -m 12g emscripten/emsdk:6.0.1 bash -s <<'SH'
apt-get update -qq && apt-get install -y -qq ninja-build   # the image has cmake, not ninja
export EM_LIBEXEC=/emsdk/upstream/emscripten ROOT=/repo
export CMAKE_BUILD_PARALLEL_LEVEL=6                        # ~1 GB per job; unbounded exhausts RAM
bash wasm-build/build-deps.sh                              # or name targets to go one at a time
SH
```

Sources are expected under `deps/src/` and are NOT fetched by the script: `osg`
(`OpenSceneGraph-3.6.5`, patched), `bullet3` (3.25), `recast` (v1.6.0), `mygui` (MyGUI3.4.3),
`ffmpeg-6.1.2`, `boost_1_85_0`, `lua-5.4.7`, `lz4-1.10.0`.

**Two headers are force-included into every translation unit** (`wasm-build/include/`):
`gl_compat.h` supplies desktop-GL vocabulary the GLES2 headers omit but OSG and OpenMW still
name — the sRGB S3TC formats, `GLdouble`/`GLclampd`, and the fixed-function enums (fog modes,
clip planes, lights, texgen, `GL_QUADS`, ...). Every value is spec-fixed and the modes they feed
are runtime no-ops in a GLES build, so this is a compile-time vocabulary gap, not a capability
claim. `mygui_char_traits_fix.h` gives `std::char_traits` for `unsigned short`/`unsigned int`,
which modern libc++ no longer provides and MyGUI's `UString` still needs.

Both previously existed only inside a maintainer's gitignored `deps/wasm/include`, so a clean
checkout could not compile a single file. They are build INPUTS and now live in the repo; a
`deps/` copy still takes precedence if you have one. Add to `gl_compat.h` only when a real
compile error demands it, and say which one.

**On Windows, check your line endings first.** A `.patch` or `.sh` checked out with CRLF is
unusable — the OSG patch fails every hunk against LF sources, and `set -euo pipefail` becomes
`pipefail
`. `.gitattributes` pins `eol=lf` for both; if you cloned before that existed, run
`git add --renormalize .`.

OSG is the most involved dep and has its own script (which `build-deps.sh` calls):
apply `wasm-build/patches/osg-emscripten.patch` to an `OpenSceneGraph-3.6.5` checkout
at `deps/src/osg`, then run `./wasm-build/build-osg.sh`. The patch carries the
critical fixes, the most important being the RTT `drawBuffers` fix in
`FrameBufferObject.cpp`. Without it, every render-to-texture camera silently discards
its color output.

## Running

The runtime needs SharedArrayBuffer, so it has to be served with cross-origin
isolation headers. `play/server.py` sets them (COOP/COEP) and also serves the
precompressed `.br` artifacts and range requests:

```bash
cd play
python3 server.py        # serves on http://localhost:8910 (override with PORT=...)
```

Then open the printed URL. To show the data-chooser launcher, enable it first (see
[Enabling the launcher](#enabling-the-launcher)).

### Multiplayer locally

The game page and the multiplayer server share one origin — the page will not hand its
session ticket to a server on a different hostname. `server.py` therefore proxies the
server's paths (`/w/`, `/auth/`, `/locker/`, `/worlds`, `/ws`) to `OPENMW_MP_UPSTREAM`,
which defaults to `127.0.0.1:8080`:

```bash
cd play
OPENMW_MP_UPSTREAM=127.0.0.1:8080 OPENMW_LAUNCHER=1 python3 server.py
```

There is no "if localhost, use a different port" shortcut in the client, on purpose: a
special case makes local behave differently from a real deployment, which is how a broken
production setup can still pass local testing.

So **something must be listening on that upstream** or multiplayer will not work locally.
With nothing there you get a clean `502` on those paths and the launcher reports the
server as unreachable — that is the correct signal, not a bug. Single-player (including
the `?nomw` demo) does not use any of this and works with no server at all.

If you change the launcher or the proxy, test the WebSocket explicitly — HTTP/2 cannot
carry an upgrade, so a browser click alone will not tell you much:

```bash
curl -i -N --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  http://127.0.0.1:8910/w/<worldId>          # expect 101 Switching Protocols
```

### Browser requirement

Desktop Chrome or Chromium only. The build relies on features that, in practice, only
desktop Chrome provides together reliably:

- SharedArrayBuffer plus WebAssembly threads (the engine runs multi-threaded).
- WebGL2 / GLES3 via ANGLE.
- `EXT_clip_control` for the reverse-Z depth buffer (Chrome-only).
- The File System Access API for the "bring your own Morrowind" folder picker.

Firefox and Safari are not supported or tested; several GLES workarounds are gated
specifically to Chrome's ANGLE behavior. Mobile and touch are out of scope (there are
no on-screen controls). Use a recent desktop Chrome or Chromium.

### Hosting on a real server

For production, serve `play/` over HTTPS (cross-origin isolation is only granted on
secure origins, though `http://localhost` also counts) and set these headers on every
response so the page is cross-origin isolated:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Because COEP is `require-corp`, every subresource must also be allowed, either
same-origin or served with `Cross-Origin-Resource-Policy: cross-origin` (which is what
`server.py` does). Serve the precompressed siblings (`openmw.wasm.br`, `openmw.js.br`)
with `Content-Encoding: br` when the client accepts it. That takes the roughly 42 MB
wasm down to about 11 MB over the wire.

nginx example:

```nginx
location /play/ {
    add_header Cross-Origin-Opener-Policy   same-origin   always;
    add_header Cross-Origin-Embedder-Policy require-corp   always;
    add_header Cross-Origin-Resource-Policy cross-origin   always;
    gzip_static on;   # or brotli_static on; to serve the .br siblings
    types { application/wasm wasm; }
}
```

If you are also running the multiplayer server, it must be reachable **on the same origin
as the game page** — the page will not hand its session ticket to a server on a different
hostname, so a separate `mp.example.com` cannot work. Reverse-proxy these paths from the
same vhost that serves `play/` to the gateway, and leave everything else on the static
handler:

```nginx
# the gameplay WebSocket: the server hands clients /w/<worldId> and they dial it here
location /w/  { proxy_pass http://gateway:8080; proxy_http_version 1.1;
                proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection upgrade; }
location /auth/   { proxy_pass http://gateway:8080; }   # single sign-on
location /locker/ { proxy_pass http://gateway:8080; }   # game-data upload
location /worlds  { proxy_pass http://gateway:8080; }   # world directory
```

Do not expose `/admin` or `/metrics`. `/w/` is the one that matters: without it sign-in
succeeds and then the game cannot connect to any world.

On static hosts (Netlify, Cloudflare Pages, GitHub Pages via a proxy, and so on), set
the same three headers through the host's headers config (for example a Netlify
`_headers` file). Those hosts serve files only, so they cannot host the multiplayer
server — it needs a real origin you control. When using the bundled retail path, the first load downloads the
Morrowind assets once; they are cached in the browser (Cache API plus IDBFS), so
later loads are fast. The in-page HUD shows live per-file download progress.

## License

openmw-web is licensed under the GNU General Public License, version 3. It is a
derivative work of OpenMW, which is itself GPLv3, so the combined work is GPLv3. The
full license text is in [`LICENSE`](LICENSE).

- Engine code (the `openmw/` tree and the WASM build changes) is GPLv3, following
  upstream OpenMW.
- The front-end and tooling in this repo (`play/`, `wasm-build/`, `fsroot/` config,
  scripts) is released under the same GPLv3.
- Bundled dependencies keep their own licenses (OSG, Bullet, MyGUI, FFmpeg, Boost,
  Lua, SDL2, and the rest). See
  [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md) and their respective source
  trees.

### Game data and trademarks

*The Elder Scrolls* and *Morrowind* are trademarks of ZeniMax Media / Bethesda
Softworks. This project is not affiliated with, endorsed by, or associated with
Bethesda or ZeniMax. No Morrowind game data is included or distributed here; you must
own and supply your own legally-obtained copy. The engine is an independent,
clean-room reimplementation (OpenMW) and ships no Bethesda assets.

## Community

Come hang out, get help, and show off your setup:

- **[Discord](https://discord.gg/PzFfDkbSue)** is the fastest place for help,
  screenshots, and news. Drop in and say hi.
- **[YouTube (@Virtastic-Apps)](https://www.youtube.com/@Virtastic-Apps)** has demos,
  build logs, and other native-to-browser ports we're working on.
- **[GitHub Discussions](https://github.com/Virtastic/openmw-web/discussions)** is for
  longer-form questions and showcase threads.

### Contributing

- Found a bug or want a feature? Open an
  [Issue](https://github.com/Virtastic/openmw-web/issues).
- Pull requests are welcome; see [`CONTRIBUTING.md`](CONTRIBUTING.md). Deployment and
  CI to our servers is maintainer-only.

## Support the project

openmw-web is built and hosted by [Virtastic](https://virtastic.app). If you enjoy
it, you can support us on [Ko-fi](https://ko-fi.com/virtastic) or
[Patreon](https://patreon.com/virtastic). It pays for the servers that host it and the
development time that keeps it moving. Nothing is behind a paywall: every mode is free to
everyone, supporter or not, and no tier buys a feature, extra storage, or a place in a queue.

## Credits

- WASM port, tooling, and hosting: (c) 2025-2026
  [Virtastic](https://virtastic.app). See [`NOTICE`](NOTICE) and
  [`AUTHORS.md`](AUTHORS.md).
- OpenMW: the engine this is built on, by the [OpenMW team](https://openmw.org/).
- Demo world: the OpenMW Example Suite (CC-BY / CC-BY-SA) by DestinedToDie and
  contributors, plus the OpenMW template data files.
</content>
</invoke>
