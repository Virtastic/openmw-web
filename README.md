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
launcher enabled there are two ways in:

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

Settings and keybindings persist in the browser (IndexedDB) and survive reloads.
Saves persist too. On the bring-your-own path they are written to an
`openmw-web-saves` folder on disk inside the folder you picked (real files, via the
File System Access API), so they survive clearing browser data and can be backed up
like any other file. The example-world path keeps saves in browser storage
(IndexedDB). A themed loading screen shows real download and mount progress on the
way in.

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
  brotli variants), the web front-end, and a ready-to-run dev server. Unzip it, run
  `python3 server.py`, and open Chrome. See
  [`SELF_HOSTING.md`](SELF_HOSTING.md) for production servers.
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
`deps/wasm/include`: OSG 3.6.5, Bullet (double-precision), MyGUI, FFmpeg 5 (with
`--enable-decoder=bink,binkaudio`), Boost (program_options plus iostreams), Lua 5.4,
LZ4, and RecastNavigation. SDL2, FreeType, HarfBuzz, png, jpeg, zlib, ogg, and vorbis
come from emscripten ports at link time; OpenAL is emscripten's built-in.

`./wasm-build/build-deps.sh` builds the whole stack from source (one function per
dep, staging into `deps/wasm/{lib,include}`). Run it with no args to build
everything, or pass targets like `build-deps.sh bullet lua`. It wraps the standard
emscripten cross-compiles for Bullet, Recast, MyGUI, FFmpeg, Boost, Lua, LZ4, the
empty OpenAL stub, the ICU-mt and libGL-getprocaddr emscripten ports, and OSG.

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

On static hosts (Netlify, Cloudflare Pages, GitHub Pages via a proxy, and so on), set
the same three headers through the host's headers config (for example a Netlify
`_headers` file). When using the bundled retail path, the first load downloads the
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
[Patreon](https://patreon.com/virtastic). It pays for the servers that keep
morrowind.virtastic.app free to play.

## Credits

- WASM port, tooling, and hosting: (c) 2025-2026
  [Virtastic](https://virtastic.app). See [`NOTICE`](NOTICE) and
  [`AUTHORS.md`](AUTHORS.md).
- OpenMW: the engine this is built on, by the [OpenMW team](https://openmw.org/).
- Demo world: the OpenMW Example Suite (CC-BY / CC-BY-SA) by DestinedToDie and
  contributors, plus the OpenMW template data files.
</content>
</invoke>
