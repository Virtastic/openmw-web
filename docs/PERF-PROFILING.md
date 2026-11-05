# Profiling the engine in a browser, and what the first profile showed

The shipped `openmw.wasm` has no name section, so a browser profile shows `wasm-function[N]`. The link
step also writes `openmw.js.symbols` (`N:name`, same index space); `Dockerfile` copies it to `play/`
but the local `play/` often lacks it. It is inside the engine images, next to the wasm it matches
(compare `md5sum`): `docker run --rm --entrypoint cat morrowind:ot3-local /srv/e/<hash>/openmw.js.symbols`.

1. `node wasm-build/perf/profile-main-thread.mjs '<url>' out.json` (Chromium, CDP Profiler, main thread
   only; it needs an awake display, a blanked one throttles rAF to ~1 fps but the per-frame CPU work
   it samples is unchanged).
2. `python3 wasm-build/perf/report.py openmw.js.symbols out.json`.

Caveat: `wasm-opt` folds identical functions, so a small self-time name can belong to another body
(`mp3_read_probe` inside `avformat_find_stream_info` is MP3 decoding, not probing). Read inclusive
time and callers before trusting a self-time name.

## First profile (2026-11-05, Balmora, 60 s walk, retail data, 4.5k samples/s, `-O3` link)

Share of `OMW::Engine::frame`: render traversals 48% (draw 27, cull 12), actor mechanics 16, Lua 11,
sound loading 11 (`FFmpegDecoder::open` 8.5). (The first read of this profile put 9% on
`ActiveSpells::update`; that was a false attribution, see "A false lead" below.)
Main-thread time blocked in `fetchChunkSync` was 4.5% of the frame, ALL of it under sound loading
(first play of a voice or effect file), on a fast local server; production telemetry shows those
reads at 300-1300 ms.

## Tried, measured, not shipped

- `object paging merge factor` 100/250/500/1000: draws per frame 900-990 throughout. Not a lever.
- FFmpeg format hint from the file extension (skip probing): the open cost is the blocking file read,
  not probing; ~0.3% of the frame. Not worth an engine bake.
- Warming all greeting/idle/service/attack/hit/follower voice lines by default (~86 MB, ~4,600 files):
  the warm-up managed 185 chunks in 100 s against 601 for the current plan, per-file overhead
  dominates. Needs the voice lines packed into a few archives first.

## Shipped

- Firefox reports no `navigator.deviceMemory`, so it always got the `mid` tier (96-chunk cache). With
  memory unknown, 8+ cores now picks `high` (prod: 593/833 evictions and 12-28 s blocked on Firefox
  sessions vs 49-269 and 0-4.5 s on Chrome `high`).

## Open leads

- Pack voice lines into archives, then warm them (removes first-play freezes).
- Rendering off the main thread (OffscreenCanvas), a wasm32 build for the vanilla game, an LTO retry.

## A false lead: `ActiveSpells::update` (9% in the first profile, 1% in fact)

The first profile showed `MWMechanics::ActiveSpells::update` at 553 ms self time, 9% of the frame.
Building the engine with that one file at `-O0` (`#pragma clang optimize off` at the top of
`activespells.cpp`, a ~20 min bake with a warm ccache) and profiling the same walk put it at 62 ms,
1.0%, and its callees (`isSpellActive`, `applyPurges`, `WorldModel::getPtr`) were tiny. `wasm-opt`
had merged identical function bodies, and the symbol map names only one function of a merged group,
so a different hot body was reported under that name. Do not optimise `ActiveSpells`. Before acting
on any self-time name in a symbolised profile, rebuild the suspect file with its optimisation off
and confirm it still costs the time; a wrong edit to upstream gameplay code is the expensive outcome.

## Building a local engine from HEAD

`fsroot/defaults.bin` (the base64 of `settings-default.cfg`) used to go stale, so an engine baked
after a settings change died at startup with "Trying to retrieve a non-existing setting"; the link step
now regenerates it. A profiling bake: `flock /tmp/omw-build.lock env DOCKER_BUILDKIT=1 docker build
--network=host --build-arg CCACHE=1 --build-arg BUILD_JOBS=6 -t morrowind:prof -f Dockerfile .`
