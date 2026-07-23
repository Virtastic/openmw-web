# openmw-web

**Play Morrowind in your browser** — the OpenMW engine compiled to WebAssembly, by [Virtastic](https://virtastic.app).

<p>
  <a href="https://morrowind.virtastic.app"><b>▶ Play now at morrowind.virtastic.app</b></a> ·
  <a href="https://github.com/Virtastic/openmw-web/releases">Releases (self-host bundle)</a> ·
  <a href="https://github.com/Virtastic/openmw-web/issues">Issues</a> ·
  <a href="https://github.com/Virtastic/openmw-web/discussions">Discussions</a>
</p>

![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPLv3-blue)
![Platform: Chrome desktop](https://img.shields.io/badge/browser-Chrome%20%2F%20Chromium-brightgreen)
[![Latest release](https://img.shields.io/github/v/release/Virtastic/openmw-web)](https://github.com/Virtastic/openmw-web/releases)

openmw-web is based on the
[OpenMW](https://openmw.org/) engine (the open-source reimplementation of
*The Elder Scrolls III: Morrowind*), effectively rebuilt in **WebAssembly** with
Emscripten so the full engine runs client-side in a desktop browser. No plugins,
no streaming service. The engine executes locally and reads game data from your
machine.

The `openmw/` tree is based on upstream
[`OpenMW/openmw`](https://github.com/OpenMW/openmw) at commit
`bc1d9c97a3881bb961a0b74e6e49bbba772b86a1` (recorded in
[`.openmw-base-commit.txt`](.openmw-base-commit.txt)) with local modifications for
the WASM target (GLES/WebGL2 shader port, threading and main-loop changes, GPU
skinning, a streaming virtual filesystem, and more). See
[`WASM_ADAPTATIONS.md`](WASM_ADAPTATIONS.md) for a full engineering writeup of how a
native desktop engine was made to run in a browser tab.

## Playing

Serve `play/` (see [Running](#running)) and open it in desktop Chrome. With the
launcher enabled you get two ways in:

- **The example world** — a small, freely-distributable demo that ships with
  OpenMW. No copy of Morrowind required. Great for a first look.
- **Bring your own Morrowind** — point the browser at your own `Data Files`
  folder from a legally-obtained install. Files are read straight from disk on
  demand via the File System Access API and streamed into the engine, so there
  is no multi-gigabyte upload or copy. The chosen folder is remembered for next
  time.

Settings and keybindings persist in the browser (IndexedDB) and survive reloads.
Saves persist too — and on the **bring-your-own** path they're written to an
`openmw-web-saves` folder **on disk** inside the folder you picked (real files,
via the File System Access API), so they outlive clearing browser data and can be
backed up like any other file; the example-world path keeps saves in browser
storage (IndexedDB). A themed loading screen shows real download / mount progress
on the way in.

**Morrowind game data is not included or distributed here.** You must supply your
own legally-obtained copy to play the full game.

### Enabling the launcher

The launcher is gated behind a flag so the bare game page stays the default when
you want it. Enable it for the dev server by copying the example env file:

```bash
cp play/.env.example play/.env      # sets OPENMW_LAUNCHER=1
```

With `OPENMW_LAUNCHER` set, the site root (`/`) serves the data chooser; without
it, `/` boots straight into the game as before. On a production host, set the
`OPENMW_LAUNCHER` environment variable (or replicate the routing) as you prefer.

## What's in this repo

This is a **code-only** repo. Large binaries (game assets, dependency source
caches, and build artifacts) are intentionally excluded via
[`.gitignore`](.gitignore) and must be provided/rebuilt locally.

| Path | Purpose |
|------|---------|
| `openmw/` | OpenMW engine source (upstream + local WASM changes) |
| `configure-openmw.sh` | Emscripten/CMake configure step for the WASM build |
| `wasm-build/link-openmw.sh` | **Canonical final link step** (runtime flags + preload FS) |
| `wasm-build/build-osg.sh` | OpenSceneGraph→WASM configure/build (the hardest dep) |
| `wasm-build/x11_stubs.c` | Signature-exact X11 no-op stubs osgViewer links against |
| `wasm-build/patches/osg-emscripten.patch` | All OSG source fixes for WebGL2/emscripten |
| `play/` | Browser front-end: `launcher.html`, `index.html`, `openmw.js` loader, `server.py` dev server |
| `fsroot/` | Virtual filesystem config + mount layout for the WASM runtime (the demo dataset itself, `fsroot/gamedata/`, is gitignored — see below) |

### Not included (kept local)

- `source-mw/`, `archive/`, `content/`, `fsroot/gamedata/`, `play/mwdata/` — copyrighted Morrowind game data
- `deps/` — cross-compiled dependency stack and its source tarballs (boost, bullet3, OSG, MyGUI, SDL2, …)
- `build-wasm/` and all `*.wasm` / `*.data` build outputs

## Self-hosting (grab and go)

You don't need to build anything to run your own instance. Every
[release](https://github.com/Virtastic/openmw-web/releases) ships:

- **`openmw-web-<tag>.zip`** — the prebuilt engine (`openmw.js/.wasm/.data`
  + brotli variants), the web front-end, and a ready-to-run dev server. Unzip,
  `python3 server.py`, open Chrome. Done. See
  [`SELF_HOSTING.md`](SELF_HOSTING.md) for production servers.
- **`openmw-web-src-<tag>.tar.gz`** — the exact source snapshot that built it
  (the GPLv3 Complete Corresponding Source).

## Building

Requires **Emscripten 6.0.1** (Homebrew paths assumed; adjust `EMSDK_BIN`), **CMake**,
and **Ninja**, plus the cross-compiled dependency stack under `deps/wasm` (not in this
repo — see *Dependency stack* below).

```bash
export ROOT=$PWD                      # repo root

# 1. Configure (compiles fine from CMake; final LINK is done out-of-band in step 3)
./configure-openmw.sh

# 2. Compile everything
ninja -C build-wasm components openmw-lib

# 3. Link with the runtime flags (WebGL2, pthreads, preload FS, IDBFS...)
./wasm-build/link-openmw.sh

# 4. Deploy
cp build-wasm/openmw.js build-wasm/openmw.wasm build-wasm/openmw.data play/
```

Build gotchas (why the link is scripted, learned the hard way):

- `main.cpp.o` is passed directly on the link line; `ninja components openmw-lib`
  does **not** rebuild it (the script does).
- The whole stack uses `-fwasm-exceptions` (legacy wasm EH). Do **not** add `-flto`
  (wasm-ld crashes / miscompiles boot) or `-sWASM_LEGACY_EXCEPTIONS=0`.
- Hand-built deps must be compiled `-pthread`; ICU uses the sysroot `-mt` variants.
- Killing the link mid-run leaves a mismatched `openmw.js`/`openmw.wasm` pair —
  verify both mtimes match before deploying.

### Dependency stack

All deps are cross-compiled to static libs in `deps/wasm/lib` (+ headers in
`deps/wasm/include`): OSG 3.6.5, Bullet (double-precision), MyGUI, FFmpeg 5
(with `--enable-decoder=bink,binkaudio`), Boost (program_options+iostreams),
Lua 5.4, LZ4, RecastNavigation. SDL2/FreeType/HarfBuzz/png/jpeg/zlib/ogg/vorbis
come from emscripten ports at link time; OpenAL is emscripten's built-in.

The whole stack is scripted from source by `./wasm-build/build-deps.sh` (one function per dep,
staging into `deps/wasm/{lib,include}`; run with no args to build everything, or pass targets like
`build-deps.sh bullet lua`). It consolidates the standard emscripten cross-compiles for Bullet,
Recast, MyGUI, FFmpeg, Boost, Lua, LZ4, the empty OpenAL stub, the ICU-mt / libGL-getprocaddr
emscripten ports, and OSG.

OSG is the hardest one and has its own script (`build-deps.sh` calls it): apply
`wasm-build/patches/osg-emscripten.patch` to an `OpenSceneGraph-3.6.5` checkout at
`deps/src/osg`, then `./wasm-build/build-osg.sh`. The patch carries critical
fixes — most importantly the RTT `drawBuffers` fix in `FrameBufferObject.cpp`
(without it every render-to-texture camera silently discards its color output).

## Running

The runtime needs SharedArrayBuffer, so it must be served with cross-origin
isolation headers. `play/server.py` sets them (COOP/COEP) and also serves the
precompressed `.br` artifacts and range requests:

```bash
cd play
python3 server.py        # serves on http://localhost:8910 (override with PORT=...)
```

Then open the printed URL. To show the data-chooser launcher, enable it first
(see [Enabling the launcher](#enabling-the-launcher)).

### Browser requirement

**Desktop Chrome / Chromium only.** The build relies on features that, in
practice, only desktop Chrome provides together reliably:

- **SharedArrayBuffer + WebAssembly threads** (the engine runs multi-threaded).
- **WebGL2 / GLES3** via ANGLE.
- **`EXT_clip_control`** for the reverse-Z depth buffer (Chrome-only).
- **File System Access API** for the "bring your own Morrowind" folder picker.

Firefox and Safari are **not supported or tested** — several GLES workarounds are
gated specifically to Chrome's ANGLE behavior. Mobile / touch is out of scope
(no on-screen controls). Use a recent desktop Chrome or Chromium.

### Hosting on a real server

For production, serve `play/` over **HTTPS** (cross-origin isolation is only
granted on secure origins; `http://localhost` also counts) and set these headers
on **every** response so the page is cross-origin isolated:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Because COEP is `require-corp`, every subresource must also be allowed — either
same-origin, or served with `Cross-Origin-Resource-Policy: cross-origin` (what
`server.py` does). Serve the precompressed siblings (`openmw.wasm.br`,
`openmw.js.br`) with `Content-Encoding: br` when the client accepts it — this
turns the ~42 MB wasm into ~11 MB over the wire.

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

On static hosts (Netlify, Cloudflare Pages, GitHub Pages via a proxy, …) set the
same three headers via the host's headers config (e.g. Netlify `_headers`). When
using the bundled retail path, the first load downloads the Morrowind assets
**once**; they are cached in the browser (Cache API + IDBFS), so subsequent loads
are fast. The in-page HUD shows live per-file download progress.

## License

openmw-web is licensed under the **GNU General Public License, version 3**. It is
a derivative work of OpenMW, which is itself GPLv3, so the combined work is GPLv3.
The full license text is in [`LICENSE`](LICENSE).

- **Engine code** (the `openmw/` tree and the WASM build changes) is GPLv3, per
  upstream OpenMW.
- **Front-end and tooling** in this repo (`play/`, `wasm-build/`, `fsroot/`
  config, scripts) is released under the same GPLv3.
- Bundled dependencies keep their own licenses (OSG, Bullet, MyGUI, FFmpeg,
  Boost, Lua, SDL2, and the rest); see
  [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md) and their respective
  source trees.

### Game data and trademarks

*The Elder Scrolls* and *Morrowind* are trademarks of ZeniMax Media / Bethesda
Softworks. This project is **not affiliated with, endorsed by, or associated with**
Bethesda or ZeniMax. **No Morrowind game data is included or distributed here** —
you must own and supply your own legally-obtained copy. The engine is an
independent, clean-room reimplementation (OpenMW); it ships no Bethesda assets.

## Community & contributing

- **Bugs / feature requests** → [Issues](https://github.com/Virtastic/openmw-web/issues)
- **Questions, showcase, help** → [Discussions](https://github.com/Virtastic/openmw-web/discussions)
- **Pull requests welcome** — see [`CONTRIBUTING.md`](CONTRIBUTING.md).
  Deployment/CI to our servers is maintainer-only.

## Support the project

openmw-web is built and hosted by [Virtastic](https://virtastic.app). If you
enjoy it, you can [support us on Patreon](https://patreon.com/virtastic) — it
pays for the servers that keep morrowind.virtastic.app free to play.

## Credits

- **WASM port, tooling, and hosting**: © 2025–2026
  [Virtastic](https://virtastic.app) — see [`NOTICE`](NOTICE) and
  [`AUTHORS.md`](AUTHORS.md).
- **OpenMW** — the engine this is built on, by the
  [OpenMW team](https://openmw.org/).
- **Demo world** — the OpenMW Example Suite (CC-BY / CC-BY-SA) by
  DestinedToDie and contributors, and the OpenMW template data files.
