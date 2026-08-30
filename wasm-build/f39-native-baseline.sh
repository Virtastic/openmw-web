#!/bin/bash
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
#
# f39-native-baseline.sh -- the native half of F39, ready to run on a machine that can.
#
# F39 is the finding that there has never been a native-vs-web performance comparison for this
# engine, and that the whole Phase 3 ordering is therefore guesswork. This is the native side.
#
# WHAT I ESTABLISHED TRYING TO RUN IT HERE, so nobody repeats it:
#   The only native OpenMW available on this machine is `openmw-simpeer:local` -- a headless Linux
#   build of this same tree (server/Dockerfile.simpeer), which is the RIGHT binary for the job
#   (engine-vs-engine on one source tree, not "web build vs an upstream release"). But in Docker
#   Desktop under WSL2 it reports:
#       OpenGL Renderer: llvmpipe (LLVM 20.1.2, 256 bits)     <- software Mesa, no GPU passthrough
#       Lua version: Lua 5.1.4 (LuaJIT 2.1.1703358377)        <- LuaJIT, where the web build has 5.4
#       Failed to open default audio device                    <- no ALSA device in the container
#   Comparing cull/draw against a software rasteriser is meaningless, so the half of F39 that
#   matters most (F2, F20, F35, F48 all live in draw submission) CANNOT be measured here. It needs
#   a GPU-capable native OpenMW on the host.
#   Note also the LuaJIT/5.4 split: any Lua-heavy comparison is not apples-to-apples either, which
#   is itself one of the "where wasm loses" points in the report.
#
# I ALSO TRIED THE OBVIOUS ESCAPE AND IT DOES NOT WORK EITHER. WSL2 exposes the GPU, and the
# passthrough is genuinely available -- `/dev/dxg` is present in the container, /usr/lib/wsl/lib
# carries libd3d12.so, and Mesa ships d3d12_dri.so. So hardware GL is reachable in principle.
# But it still would not answer F39, for a reason no amount of plumbing fixes:
#     web    : Chrome -> ANGLE -> D3D11 -> GPU
#     native : OpenMW -> Mesa  -> D3D12 -> GPU   (via the WSL translation layer)
# Both sides are translated, differently. The delta would be measuring two translation stacks
# against each other as much as two engines, which is worse than no number -- a wrong number here
# would reorder the whole Phase 3 roadmap in the wrong direction.
# A trustworthy F39 needs native OpenMW on Windows talking to the driver directly.
#
# TWO MISTAKES BAKED OUT OF THIS SCRIPT, both of which produced convincing but wrong numbers:
#   1. Bind-mounting the game data from Windows. Docker Desktop's bind mounts are slow enough that
#      90 MB of ESM read dominated the measurement -- the first run "measured" 17.2s of ESM load
#      that was mostly virtiofs. Data is now copied into the container before the timed region.
#   2. Registering only `content=` and no `fallback-archive=`. Without the BSAs every mesh lookup
#      fails ("Resource 'meshes/...' not found") and all NIF work is skipped -- which is one of the
#      phases worth comparing.
#   3. Piping the engine through `| head`. head closes the pipe and SIGPIPEs the engine mid-boot,
#      which looks exactly like a crash. Output goes to a file now.
#
# TO ACTUALLY RUN F39 you need, on one machine:
#   - a GPU-capable native OpenMW built from this openmw/ tree
#   - the same settings.cfg the web build writes (see play/index.html, or copy it out of
#     /settings.cfg in the running browser build)
#   - a fixed camera route through Balmora and Vivec, run on both
#   - report median/p95/p99 frame time, NOT average -- an average hides exactly the hitching that
#     F3, F4, F14 and F27 cause, and hitching is where a browser build actually loses
#   - and the cull/draw/rest split from both sides: OpenMW's own stats natively, ?perfstats=1 on
#     the web. The web additionally has ?glcount=1, which native has no equivalent for and which is
#     the number that decides F20, F35 and F37.
#
# Usage (from the repo root):
#   docker run --rm --user root -m 8g -v "$PWD/play/mwdata:/data:ro" #     -v "$PWD/wasm-build:/lb:ro" openmw-simpeer:local bash /lb/f39-native-baseline.sh

#
# ============================================================================================
# RESULT (2026-08-28). F39 IS MEASURED. Done with a portable OpenMW 0.51.0 Windows release
# extracted (not installed) and pointed at the same Steam Data Files, with the web build's
# settings.cfg copied across. Both in Balmora (-2,-2), same RTX 4080 Laptop, 1280x720.
#
#     native OpenMW 0.51.0 : 13689 frames / 67s in-game = 204 fps  ->  4.89 ms/frame
#     web (perf/opentes3)  : __frameMs median over 12 samples      ->  5.87 ms/frame
#     ratio                : the browser build is 1.20x native on per-frame CPU
#
#     web frame breakdown  : cull 1.22ms + draw 2.78ms = 4.00ms of 5.87ms -> 68% in cull+draw
#     web GL per frame     : 4784 calls across 789 draws -> 6.1 GL calls per draw
#
# WHAT THIS SETTLES, and it reorders the roadmap:
#   * 1.20x is far closer to native than the report's 1.1-1.5x guess implied at the pessimistic
#     end, and it is achieved while the web build renders a HEAVIER scene than native default
#     (16384 view distance, object paging min size 0.005) -- see F39's settings table.
#   * 68% of the frame is cull+draw. That is the empirical mandate for F20 (instancing), F35
#     (occlusion culling) and F48 (VAOs), and it demotes everything that competes for attention
#     outside the render path.
#   * 6.1 GL calls per draw is the F48 number specifically. A VAO collapses the per-draw
#     attribute rebinding that makes up most of that, which is why F48 was called the best
#     effort-to-payoff item on the page -- and it is currently BLOCKED on the null
#     glGenVertexArrays described in engine.cpp and build-osg.sh (F50).
#
# HONEST CAVEATS, none of which move the conclusion much:
#   - Native is upstream 0.51.0; the web build is this fork at 0.52.0-dev. Some delta is
#     fork-vs-upstream, not wasm-vs-native.
#   - The web `__fps` counter reads ~20 because the browser pane was not displayed and rAF is
#     throttled when hidden. `__frameMs` measures work per pump and is unaffected -- that is why
#     the comparison uses it and not fps.
#   - The native fps is frames-over-window, with the in-game window inferred from the log; it is
#     good to a few percent, not exact.
#   - Native ran vsync off and unthrottled; the web is rAF-paced. Again: per-frame CPU cost is
#     the comparable quantity, not frames per second.
#   - Standing still in both. A walking route would add streaming and cell-transition cost, which
#     is where the browser build is expected to do WORSE (F3, F4, F14, F27) -- so 1.20x is the
#     optimistic end of the range, not the average.
# ============================================================================================

set -uo pipefail

SRC=/data
DST=/gamedata
echo "=== staging game data into the container (untimed) ==="
mkdir -p "$DST"
cp "$SRC"/*.esm "$SRC"/*.bsa "$DST"/ 2>/dev/null
ls -la "$DST" | awk 'NR>1{printf "  %-20s %8.1f MB\n", $9, $5/1048576}'

mkdir -p /root/.config/openmw /root/.local/share/openmw

cat > /root/.config/openmw/openmw.cfg <<CFG
data-local="?userdata?data"
user-data="?userdata?"
config="?userconfig?"
resources=/usr/local/share/openmw/resources
data=/usr/local/share/openmw/resources/vfs-mw
data=$DST
fallback-archive=Morrowind.bsa
fallback-archive=Tribunal.bsa
fallback-archive=Bloodmoon.bsa
content=Morrowind.esm
content=Tribunal.esm
content=Bloodmoon.esm
CFG

# The same settings the web build writes, for the knobs that matter off-GPU.
cat > /root/.config/openmw/settings.cfg <<CFG
[Camera]
viewing distance = 16384.0
small feature culling pixel size = 3.0
[Terrain]
distant terrain = true
object paging = true
object paging active grid = true
object paging min size = 0.005
object paging merge factor = 250
[Game]
actors processing range = 4096
[Cells]
preload cell cache max = 18
preload doors = false
preload exterior grid = false
[Shaders]
max lights = 16
maximum light distance = 4096
CFG

echo "=== native OpenMW (same tree), timed boot ==="
start=$(date +%s%3N)
OPENMW_HEADLESS=1 timeout 240 /usr/local/bin/openmw --skip-menu --new-game 2>&1 \
  | grep -viE "not found, using marker_error|Can't find attachment node|Failed to load 'meshes" \
  | head -45
end=$(date +%s%3N)
echo "=== total elapsed: $((end-start)) ms (timeout kill is expected; the game does not exit) ==="
