<!-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app
     SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web -->
# Building the engine from source

You do not need any of this to play or to run a server - the
[releases](https://github.com/Virtastic/openmw-web/releases) ship a prebuilt engine. This is
for people changing the engine itself. Stuck? Ask in
[Discord](https://discord.gg/PzFfDkbSue).

You need **Emscripten 6.0.1**, CMake, Ninja, and the cross-compiled dependency stack under
`deps/wasm64` (see [Dependency stack](#dependency-stack)).

```bash
export ROOT=$PWD

./wasm-build/build-deps.sh            # -> deps/wasm64  (once; see below)
./configure-openmw.sh
ninja -C build-wasm64 components openmw-lib
./wasm-build/link-openmw.sh
cp build-wasm64/openmw.{js,wasm,data} play/
```

## wasm64 (MEMORY64) is the only target

The engine is built for wasm64 and nothing else: it lifts the heap above the 4 GiB a 32-bit
module can address, which a Tamriel Rebuilt load order needs, and the client gates on
MEMORY64 to match. `OMW_WASM64=0` refuses with an error. Browsers need memory64:
Chrome/Edge 133+ or Firefox 134+ (the pages feature-detect and say so).

Notes, all learned the hard way:

- **`-m64`, not `-sMEMORY64=1`** - the `-s` spelling is deprecated, and `-m64` is a compiler
  flag so it reaches CMake's `try_compile` probes.
- Pointer models **cannot share a build tree or dep prefix**. A mixed archive fails only at
  the final link (`wasm32 object file can't be linked in wasm64 mode`); `build-deps.sh`
  stamps each source tree with its model and cleans on change.
- `wasm-build/memory64-gate.sh` checks the toolchain, threads, >4 GiB allocation and the JS
  pointer ABI without building the engine - run it first when something looks wrong.

## The link step is scripted for reasons

- `main.cpp.o` is passed directly on the link line; `ninja components openmw-lib` does not
  rebuild it - `link-openmw.sh` does.
- Everything uses `-fwasm-exceptions`. Do not add `-flto` (wasm-ld crashes or miscompiles
  boot) or `-sWASM_LEGACY_EXCEPTIONS=0`.
- Hand-built deps must be `-pthread`; ICU uses the sysroot `-mt` variants.
- A killed link leaves a mismatched `openmw.js`/`openmw.wasm` pair - check both mtimes match
  before deploying.

## Dependency stack

Static libs in `deps/wasm64/lib`, headers in `deps/wasm64/include`: OSG 3.6.5, Bullet
(double-precision), MyGUI, FFmpeg 6, Boost (program_options + iostreams), Lua 5.4, LZ4,
RecastNavigation. SDL2, FreeType, HarfBuzz, png, jpeg, zlib, ogg and vorbis come from
emscripten ports at link time; OpenAL is emscripten's built-in.

`./wasm-build/build-deps.sh` builds the whole stack (or named targets:
`build-deps.sh bullet lua`). Sources are expected under `deps/src/` and are **not** fetched:
`osg` (OpenSceneGraph-3.6.5, patched), `bullet3` (3.25), `recast` (v1.6.0), `mygui`
(MyGUI3.4.3), `ffmpeg-6.1.2`, `boost_1_85_0`, `lua-5.4.7`, `lz4-1.10.0`.

**In Docker** (the image has cmake but not ninja, and unbounded jobs exhaust RAM):

```bash
docker run --rm -i -v "$PWD:/repo" -w /repo -m 12g emscripten/emsdk:6.0.1 bash -s <<'SH'
apt-get update -qq && apt-get install -y -qq ninja-build
export EM_LIBEXEC=/emsdk/upstream/emscripten ROOT=/repo CMAKE_BUILD_PARALLEL_LEVEL=6
bash wasm-build/build-deps.sh
SH
```

**OSG** is the involved one: apply `wasm-build/patches/osg-emscripten.patch` to an
`OpenSceneGraph-3.6.5` checkout at `deps/src/osg`, then `./wasm-build/build-osg.sh`. The
patch's most important fix is the RTT `drawBuffers` one - without it every render-to-texture
camera silently discards its color output.

**Two headers are force-included into every translation unit** (`wasm-build/include/`):
`gl_compat.h` (desktop-GL vocabulary the GLES headers omit but OSG/OpenMW still name - all
spec-fixed values feeding runtime no-ops) and `mygui_char_traits_fix.h`
(`std::char_traits` for the wide types modern libc++ dropped and MyGUI still needs). They are
build inputs and live in the repo; add to `gl_compat.h` only when a real compile error
demands it.

**On Windows, check line endings first.** A `.patch` or `.sh` checked out with CRLF is
unusable. `.gitattributes` pins `eol=lf`; if you cloned before it existed, run
`git add --renormalize .`.

## Running what you built

The runtime needs cross-origin isolation (SharedArrayBuffer). The dev server sets the
headers, serves the `.br` siblings, and handles range requests:

```bash
cd play
python3 server.py        # http://localhost:8910 (PORT=... to override)
```

### Multiplayer against a local server

The game page and the server must share one origin - the page will not hand its session
ticket to a different hostname. `server.py` proxies the server paths for that:

```bash
cd play
OPENMW_MP_UPSTREAM=127.0.0.1:8080 OPENMW_LAUNCHER=1 python3 server.py
```

Something must be listening on the upstream, or those paths 502 - which is the correct
signal, not a bug. Single player needs no server at all. If you touch the launcher or the
proxy, test the WebSocket explicitly (HTTP/2 cannot carry an upgrade):

```bash
curl -i -N --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  http://127.0.0.1:8910/w/<worldId>          # expect 101 Switching Protocols
```
