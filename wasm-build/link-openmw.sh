#!/bin/bash
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
# Canonical OpenMW->WASM link step.
#
# CMake/ninja can compile everything (`ninja -C build-wasm components openmw-lib` +
# `ninja -C build-wasm apps/openmw/CMakeFiles/openmw.dir/main.cpp.o`), but the final link
# needs runtime flags (preload FS, pthread pool, WebGL2, IDBFS...) that break CMake's
# configure-time checks, so it is done out-of-band by this script.
#
# Usage:
#   ROOT=/path/to/CS-Web ./wasm-build/link-openmw.sh
# Produces build-wasm/openmw.{js,wasm,data}; deploy with:
#   cp build-wasm/openmw.js build-wasm/openmw.wasm build-wasm/openmw.data play/
#
# GOTCHAS (learned the hard way):
# - main.cpp.o is passed directly on the link line and is NOT rebuilt by
#   `ninja components openmw-lib` — build it explicitly (done below).
# - Killing this link mid-run leaves a MISMATCHED openmw.js/openmw.wasm pair; always
#   check both mtimes match before deploying.
# - Whole stack is -fwasm-exceptions (LEGACY wasm EH). Do NOT add -flto (wasm-ld
#   crashes / miscompiles boot) and do NOT set -sWASM_LEGACY_EXCEPTIONS=0.
# - ICU must be the -mt sysroot variants; hand-built deps must be compiled -pthread.

set -euo pipefail

ROOT="${ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# Emscripten runs on python3 from PATH and REQUIRES >= 3.10. macOS ships /usr/bin/python3 at
# 3.9, and on a fresh login shell that can sit ahead of Homebrew's — at which point emcc dies
# inside CMake's configure step with a traceback about sys.version_info, which reads like a
# broken build rather than a broken PATH. Put Homebrew first so the build cannot inherit it.
export PATH="/opt/homebrew/bin:$PATH"
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'; then
  echo "emscripten needs python3 >= 3.10; PATH resolves to $(python3 --version 2>&1) at $(command -v python3)" >&2
  exit 1
fi

EMSDK_BIN="${EMSDK_BIN:-/opt/homebrew/Cellar/emscripten/6.0.1/libexec}"
SYSROOT="$EMSDK_BIN/cache/sysroot/lib/wasm32-emscripten"
LIB="$ROOT/deps/wasm/lib"
INC="$ROOT/deps/wasm/include"
# Force-included into every translation unit. These are build INPUTS, so they live in the
# repo — they used to exist only in the maintainer's gitignored deps/wasm/include, which meant
# a clean checkout could not compile a single file ("gl_compat.h file not found"). A deps/
# copy still wins if one is present, so an existing maintainer tree is untouched.
OMW_FORCE_INC="$ROOT/wasm-build/include"
[ -f "$INC/gl_compat.h" ] && OMW_FORCE_INC="$INC"
BUILD="$ROOT/build-wasm"

cd "$BUILD"

# The multiplayer Lua package is authored in openmw/files/data but packed from the fsroot
# preload mirror — sync it here so the two can never drift (the rest of resources/vfs is a
# deliberately-divergent manual mirror; mp/ is exact by construction).
#
# cp, not rsync: the release image (Dockerfile) has no rsync, so this line exited 127 and took
# the whole v1.1.0 release build with it after a 13-minute compile. The Jenkins builder happens
# to have rsync installed, so the dev path stayed green and only the PUBLIC release broke.
# Removing the dependency is smaller than installing a package into the image for one directory
# copy. `rm -rf` then `cp -a` is exactly `rsync -a --delete` for this case: mirror the source,
# drop anything stale in the destination.
MP_SRC="$ROOT/openmw/files/data/scripts/mp"
MP_DST="$ROOT/fsroot/resources/vfs/scripts/mp"
rm -rf "$MP_DST"
mkdir -p "$MP_DST"
cp -a "$MP_SRC/." "$MP_DST/"
cp "$ROOT/openmw/files/data/mp.omwscripts" "$ROOT/fsroot/resources/vfs/mp.omwscripts"

# ICU DATA. The emscripten ICU port links `libicu_stubdata` — ICU's "data supplied elsewhere"
# placeholder — and ships the actual package under ports/icu without linking it. Nothing was
# supplying it, so ICU had NO locale data: NumberFormat::createInstance returned null and
# MessageFormat::format called a virtual on it, which is a bare `RuntimeError: null function`
# in wasm. The engine died in SettingsWindow's constructor on every single boot.
#
# main.cpp points ICU here with u_setDataDirectory("/icu") under __EMSCRIPTEN__; this stages the
# package it reads. Copied from the emsdk cache rather than committed: it is ~28 MB of upstream
# build output, and it belongs in the same category as the rest of deps/.
# Three places it can come from, in order. The emsdk cache is only populated where the ICU
# port has actually been built, and the prebaked builder image (openmw-builder:1) does NOT
# carry it -- the data is staged into the source tree instead, which is the convention
# ci/jenkins/build-engine.sh asserts on and sync-to-builder.sh restages from
# ~/build-artifacts. Looking only in the cache made this script fail every build on the
# build server while passing on a laptop with a warm emsdk -- so accept a pre-staged copy
# and fall back to the cache, rather than the other way round.
ICU_TARGET="$ROOT/fsroot/icu/icudt68l.dat"
ICU_STAGED="$ROOT/fsroot/icudt68l.dat"
ICU_DAT="${EMSDK_BIN}/cache/ports/icu/icu/source/data/in/icudt68l.dat"
# TRIM -- DISABLED. See wasm-build/trim-icu-data.py.
# The finding is real (28.6 MB of a 32 MB openmw.data, for six locales and a MessageFormat), but
# the naive TOC filter is NOT a safe way to get it, and this was proven by running it:
#
#   With the trim, the engine boots normally all the way to "Reserving texture unit for sky RTT"
#   and then dies with `unhandled rejection: null function`. Restoring the full package with every
#   other change in place boots clean. Bisected: dropping FEATURE GROUPS (coll/zone/curr/...) alone
#   is fine; dropping other LOCALES is what breaks it.
#
# Why: the package still contains ICU's locale INDEX resources, which continue to advertise the
# ~800 locales whose .res entries were removed. ICU opens one, gets nothing back, and calls a
# virtual on the null -- the same bare "null function" this data caused when it was absent
# entirely. Filtering the built .dat cannot fix that; the index has to be regenerated, which is
# exactly what upstream's ICU_DATA_FILTER_FILE does and what the script's header wrongly dismissed.
#
# To land this properly: build the ICU data with ICU_DATA_FILTER_FILE (needs a native ICU build in
# the deps stack), or extend trim-icu-data.py to rewrite res_index.res for every kept tree. Until
# then ship the full package -- 26 MB is worth having, but not at the cost of a boot crash.
ICU_TRIM="${ICU_TRIM:-0}"
trim_icu() {   # trim_icu <src> <dst>
  if [ "$ICU_TRIM" = "1" ]; then
    python3 "$ROOT/wasm-build/trim-icu-data.py" "$1" "$2"       --verify-l10n "$ROOT/fsroot/resources/vfs/l10n"
  else
    cp "$1" "$2"
  fi
}

if [ -s "$ICU_TARGET" ]; then
  echo "   ICU data already staged at fsroot/icu/icudt68l.dat"
elif [ -s "$ICU_STAGED" ]; then
  mkdir -p "$ROOT/fsroot/icu"
  trim_icu "$ICU_STAGED" "$ICU_TARGET"
  echo "   ICU data staged from fsroot/icudt68l.dat"
elif [ -f "$ICU_DAT" ]; then
  mkdir -p "$ROOT/fsroot/icu"
  trim_icu "$ICU_DAT" "$ICU_TARGET"
  echo "   ICU data staged from the emsdk ports cache"
else
  echo "!! ICU data package not found. Looked in:" >&2
  echo "     $ICU_TARGET" >&2
  echo "     $ICU_STAGED" >&2
  echo "     $ICU_DAT" >&2
  echo "   The engine will link, boot, and then die with 'null function' in SettingsWindow." >&2
  exit 1
fi

# Make sure the objects on the explicit link line are fresh.
#
# openmw-lib AND components must be built here, not just main.cpp.o. The link line below
# names libopenmw-lib.a and libcomponents.a directly, so a stale archive links CLEANLY and
# silently ships an engine without your change in it. That is not hypothetical: a new
# openmw.mp Lua binding was added to luabindings.cpp (in openmw-lib), only main.cpp.o was
# rebuilt, and the deployed client threw "attempt to call a nil value" at runtime — which
# killed the whole MP transport, because a throwing Lua handler disables its subsystem.
# Ninja no-ops these in seconds when nothing changed, so there is no reason to skip them.
ninja components openmw-lib
ninja apps/openmw/CMakeFiles/openmw.dir/main.cpp.o

# X11 no-op stubs (osgViewer's X11 backend symbols; see wasm-build/x11_stubs.c).
"$EMSDK_BIN/emcc" -O2 -pthread -fwasm-exceptions -msimd128 -c "$ROOT/wasm-build/x11_stubs.c" -o "$BUILD/x11_stubs.o"

"$EMSDK_BIN/em++" \
  -D_LIBCPP_ENABLE_CXX17_REMOVED_FEATURES -DBT_USE_DOUBLE_PRECISION \
  `# -msimd128 must match configure-openmw.sh: every hand-built dep already carries it, and` \
  `# main.cpp.o is compiled HERE rather than by cmake, so it would otherwise be the odd one out.` \
  -fwasm-exceptions -msimd128 \
  -include "$OMW_FORCE_INC/mygui_char_traits_fix.h" -include "$OMW_FORCE_INC/gl_compat.h" \
  -Wno-missing-template-arg-list-after-template-kw -Wno-error=missing-template-arg-list-after-template-kw \
  -pthread \
  -I"$ROOT/deps/src/bullet3/src" -I"$INC" -I"$ROOT/deps/src/boost_1_85_0" \
  -O3 -DNDEBUG \
  -lopenal \
  --use-port=sdl2 --use-port=freetype --use-port=harfbuzz --use-port=libpng \
  --use-port=libjpeg --use-port=zlib --use-port=ogg --use-port=vorbis \
  -sALLOW_MEMORY_GROWTH=1 -sMAX_WEBGL_VERSION=2 -sMIN_WEBGL_VERSION=2 -sFULL_ES3=1 \
  -sEXIT_RUNTIME=0 -sPTHREAD_POOL_SIZE=8 -sINITIAL_MEMORY=1610612736 \
  `# MAXIMUM_MEMORY defaults to 2GB (emsdk src/settings.js:211), so ALLOW_MEMORY_GROWTH over a` \
  `# 1.5GB initial had only ~512MB of headroom -- the shadow map alone was ~1GB before it was` \
  `# halved. wasm32 addresses 4GB and Chrome supports it, so take the other half.` \
  -sMAXIMUM_MEMORY=4294967296 \
  -sASSERTIONS=0 -sMALLOC=mimalloc \
  -sENVIRONMENT=web,worker \
  ${OMW_PROFILING:+--profiling-funcs} \
  ${OMW_CLOSURE:+--closure=1} \
  -Wl,--whole-archive \
    "$LIB/libosgdb_bmp.a" "$LIB/libosgdb_dds.a" "$LIB/libosgdb_freetype.a" \
    "$LIB/libosgdb_jpeg.a" "$LIB/libosgdb_osg.a" "$LIB/libosgdb_png.a" \
    "$LIB/libosgdb_serializers_osg.a" "$LIB/libosgdb_tga.a" \
  -Wl,--no-whole-archive \
  apps/openmw/CMakeFiles/openmw.dir/main.cpp.o \
  -o openmw.js \
  apps/openmw/libopenmw-lib.a \
  extern/osg-ffmpeg-videoplayer/libosg-ffmpeg-videoplayer.a \
  "$LIB/libavcodec.a" "$LIB/libavformat.a" "$LIB/libavutil.a" \
  "$LIB/libswscale.a" "$LIB/libswresample.a" \
  extern/oics/liboics.a extern/oics/liblocal_tinyxml.a \
  components/libcomponents.a \
  "$LIB/libosgParticle.a" "$LIB/libosgViewer.a" "$LIB/libosgShadow.a" \
  "$LIB/libboost_program_options.a" \
  "$LIB/libosgAnimation.a" "$LIB/libosgGA.a" "$LIB/libosgText.a" \
  "$LIB/libosgDB.a" "$LIB/libosgUtil.a" "$LIB/libosgSim.a" "$LIB/libosg.a" \
  "$LIB/libOpenThreads.a" "$LIB/libboost_iostreams.a" \
  "$SYSROOT/libGL-getprocaddr.a" \
  "$LIB/libMyGUIEngineStatic.a" "$LIB/liblua.a" "$LIB/libopenal_stub.a" "$LIB/liblz4.a" \
  _deps/recastnavigation-build/DebugUtils/libDebugUtils.a \
  _deps/recastnavigation-build/DetourTileCache/libDetourTileCache.a \
  _deps/recastnavigation-build/Detour/libDetour.a \
  _deps/recastnavigation-build/Recast/libRecast.a \
  extern/libsqlite3.a extern/smhasher/libsmhasher.a \
  "$SYSROOT/libicu_common-mt.a" "$SYSROOT/libicu_i18n-mt.a" "$SYSROOT/libicu_stubdata-mt.a" \
  _deps/yaml-cpp-build/libyaml-cpp.a \
  "$LIB/libBulletCollision.a" "$LIB/libLinearMath.a" \
  "$BUILD/x11_stubs.o" \
  -sERROR_ON_UNDEFINED_SYMBOLS=0 \
  -lidbfs.js -lwebsocket.js -sFORCE_FILESYSTEM=1 \
  -sEXPORTED_RUNTIME_METHODS=['FS','ENV','callMain','Browser','stringToNewUTF8','UTF8ToString'] \
  -sEXPORTED_FUNCTIONS=['_main','_malloc','_free'] \
  --preload-file "$ROOT/fsroot@/"

echo "Linked: $(ls -la openmw.js openmw.wasm openmw.data | awk '{print $9, $5}')"
echo "Deploy: cp build-wasm/openmw.{js,wasm,data} play/"
