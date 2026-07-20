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

ROOT="${ROOT:-/Users/mstavridis/Downloads/CS-Web}"
EMSDK_BIN="${EMSDK_BIN:-/opt/homebrew/Cellar/emscripten/6.0.1/libexec}"
SYSROOT="$EMSDK_BIN/cache/sysroot/lib/wasm32-emscripten"
LIB="$ROOT/deps/wasm/lib"
INC="$ROOT/deps/wasm/include"
BUILD="$ROOT/build-wasm"

cd "$BUILD"

# The multiplayer Lua package is authored in openmw/files/data but packed from the fsroot
# preload mirror — sync it here so the two can never drift (the rest of resources/vfs is a
# deliberately-divergent manual mirror; mp/ is exact by construction).
rsync -a --delete "$ROOT/openmw/files/data/scripts/mp/" "$ROOT/fsroot/resources/vfs/scripts/mp/"
cp "$ROOT/openmw/files/data/mp.omwscripts" "$ROOT/fsroot/resources/vfs/mp.omwscripts"

# Make sure the objects on the explicit link line are fresh.
ninja apps/openmw/CMakeFiles/openmw.dir/main.cpp.o

# X11 no-op stubs (osgViewer's X11 backend symbols; see wasm-build/x11_stubs.c).
"$EMSDK_BIN/emcc" -O2 -pthread -fwasm-exceptions -c "$ROOT/wasm-build/x11_stubs.c" -o "$BUILD/x11_stubs.o"

"$EMSDK_BIN/em++" \
  -D_LIBCPP_ENABLE_CXX17_REMOVED_FEATURES -DBT_USE_DOUBLE_PRECISION \
  -fwasm-exceptions \
  -include "$INC/mygui_char_traits_fix.h" -include "$INC/gl_compat.h" \
  -Wno-missing-template-arg-list-after-template-kw -Wno-error=missing-template-arg-list-after-template-kw \
  -pthread \
  -I"$ROOT/deps/src/bullet3/src" -I"$INC" -I"$ROOT/deps/src/boost_1_85_0" \
  -O3 -DNDEBUG \
  -lopenal \
  --use-port=sdl2 --use-port=freetype --use-port=harfbuzz --use-port=libpng \
  --use-port=libjpeg --use-port=zlib --use-port=ogg --use-port=vorbis \
  -sALLOW_MEMORY_GROWTH=1 -sMAX_WEBGL_VERSION=2 -sMIN_WEBGL_VERSION=2 -sFULL_ES3=1 \
  -sEXIT_RUNTIME=0 -sPTHREAD_POOL_SIZE=8 -sINITIAL_MEMORY=1610612736 \
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
