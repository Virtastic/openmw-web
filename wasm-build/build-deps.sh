#!/bin/bash
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
# =============================================================================================
# build-deps.sh — rebuild the ENTIRE WASM dependency stack from source in deps/src/ into
# deps/wasm/{lib,include}. This is the end-to-end recipe that previously only existed ad-hoc
# (only OSG was scripted). Consolidates the standard emscripten cross-compiles + the flags
# documented in README.md §"Dependency stack".
#
# Sources expected under deps/src/ (already in the tree): osg (patched), bullet3, recast, mygui,
# ffmpeg-6.1.2, boost_1_85_0, lua-5.4.7, lz4-1.10.0. Emscripten PORTS provide the rest
# (SDL2/FreeType/HarfBuzz/png/jpeg/zlib/ogg/vorbis at link time; ICU + libGL-getprocaddr into the
# sysroot; OpenAL is emscripten's built-in — we only stage an empty `openal_stub` to satisfy CMake).
#
# Usage:
#   ROOT=/path/to/repo EM_LIBEXEC=/path/to/emscripten/libexec ./wasm-build/build-deps.sh [target...]
#   (no target => build everything, in order)   e.g. ./wasm-build/build-deps.sh bullet recast lua
#
# NOTE: I authored this from the standard emscripten build patterns + the README flags and could NOT
# compile-test it here. The from-source builds most likely to need a round of iteration on the target
# toolchain are marked  ### VERIFY ###  (Boost b2 toolset, MyGUI FreeType wiring, the ICU/GL ports).
# All wasm .a archives are ABI-stable across emscripten patch versions.
# =============================================================================================
set -euo pipefail

ROOT="${ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EM_LIBEXEC="${EM_LIBEXEC:-/opt/homebrew/Cellar/emscripten/6.0.1/libexec}"
SR="$EM_LIBEXEC/cache/sysroot"
SRC="$ROOT/deps/src"
# Overridable, because parallelism here is MEMORY-bound and not core-bound -- the same lesson
# the root Dockerfile:26-40 records for the engine build. nproc on a 32-core builder starts 32
# clang processes against ~1 GB each (README: CMAKE_BUILD_PARALLEL_LEVEL=6), and the kernel OOM
# killer picks the biggest process it can find, which is not necessarily this build.
JOBS="${JOBS:-$( (nproc 2>/dev/null) || sysctl -n hw.ncpu 2>/dev/null || echo 4)}"

# --- WASM64 (MEMORY64) -----------------------------------------------------------------------
# OFF by default: the wasm32 stack in deps/wasm and everything that reads it stay exactly as they
# were, so this is reversible by unsetting one variable rather than by rebuilding.
# OMW_WASM64=1 builds the WHOLE stack into deps/wasm64 instead.
#
# -m64, NOT -sMEMORY64=1: emscripten 6.0.1 accepts both but warns the -s spelling is deprecated
# ("prefer the standard -m64 or --target=wasm64 flags"). -m64 is a clang-style flag, so unlike a
# linker setting it reaches CMake try_compile probes the same way -msimd128 and -pthread do --
# which matters here because half this file drives CMake.
#
# A wasm64 archive and a wasm32 archive CANNOT be mixed: wasm-ld refuses the link outright. That
# is the good failure mode, and it is why the two stacks live in separate prefixes rather than
# overwriting one another.
#
# ffmpeg keeps --arch=$WASM_ARCH as a LABEL only: --disable-asm is already set, so it selects
# generic C paths either way. Its real pointer size comes from -m64, which must be passed to
# BOTH --extra-cflags and --extra-ldflags (see build_ffmpeg). ffmpeg prints
# "WARNING: unknown architecture wasm64" and falls back to generic C -- that warning is
# expected and is not the reason for any failure.
if [ "${OMW_WASM64:-0}" = "1" ]; then
  WASM_ARCH="wasm64"; ARCH_FLAG="-m64"; DW="$ROOT/deps/wasm64"; BUILD_DIR="build-wasm64"
else
  WASM_ARCH="wasm32"; ARCH_FLAG="";     DW="$ROOT/deps/wasm";   BUILD_DIR="build-wasm"
fi
# GL archive name. emcc encodes the build variant into the filename, and under -pthread the
# port materialises as libGL-mt-getprocaddr.a rather than libGL-getprocaddr.a. The wasm32 stack
# never noticed: the prebaked builder image ships EVERY variant, so the non-mt name it asks for
# happens to exist. A freshly-populated wasm64 sysroot only has the variant actually built, so
# take whichever is present and fail loudly if neither is.
GLDIR="$SR/lib/$WASM_ARCH-emscripten"
LIBGL="$GLDIR/libGL-getprocaddr.a"
[ -f "$LIBGL" ] || LIBGL="$GLDIR/libGL-mt-getprocaddr.a"

# Shared flags: pthreads (SharedArrayBuffer build), wasm-EH (throwing static ctors), SIMD, no strict
# aliasing/overflow (matches the OSG + OpenMW builds so ABIs line up).
CFLAGS_COMMON="-O2 -pthread -fwasm-exceptions -msimd128 -fno-strict-aliasing -fno-strict-overflow${ARCH_FLAG:+ $ARCH_FLAG}"

mkdir -p "$DW/lib" "$DW/include"
stage_lib() { cp -f "$@" "$DW/lib/"; }

# ffmpeg, lz4 and boost build IN-TREE, so unlike the CMake deps above they cannot simply be
# given a per-model build directory. Switching OMW_WASM64 would leave wasm32 objects sitting in
# the tree for `make` to consider up to date, and they would be archived into a wasm64 .a --
# the same stale-object fault the root Dockerfile:26-40 refuses a ninja cache mount over. Here
# wasm-ld would eventually catch it, but only after a long build and with a confusing message.
# A stamp file per source tree is cheaper than either.
# NO STAMP MEANS UNKNOWN, NOT CLEAN. The first version treated a missing stamp as "nothing to
# clean", which is wrong for exactly the case that matters: every existing checkout has a source
# tree full of wasm32 objects and no stamp, so the first wasm64 build re-archived them and
# produced a deps/wasm64/liblz4.a that was entirely wasm32. wasm-ld caught it --
# "wasm32 object file can't be linked in wasm64 mode" -- but only at the final engine link,
# hours later. Clean unless the stamp positively says this tree already matches.
arch_guard() {  # arch_guard <src-dir> <clean command...>
  local d="$1"; shift
  local stamp="$d/.omw-wasm-arch"
  local had; had="$(cat "$stamp" 2>/dev/null || echo none)"
  if [ "$had" != "$WASM_ARCH" ]; then
    log "arch is '$had', want '$WASM_ARCH' in ${d#$ROOT/}; cleaning in-tree objects"
    ( cd "$d" && "$@" ) || true
  fi
  echo "$WASM_ARCH" > "$stamp"
}
log() { echo "=== build-deps: $* ==="; }
log "target=$WASM_ARCH prefix=$DW"

# --- Bullet (double precision, static) -> libBullet{Collision,Dynamics,SoftBody}.a + libLinearMath.a
build_bullet() {
  log "bullet3"
  emcmake cmake -S "$SRC/bullet3" -B "$SRC/bullet3/$BUILD_DIR" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DBUILD_SHARED_LIBS=OFF -DUSE_DOUBLE_PRECISION=ON \
    -DBUILD_BULLET2_DEMOS=OFF -DBUILD_CPU_DEMOS=OFF -DBUILD_OPENGL3_DEMOS=OFF \
    -DBUILD_UNIT_TESTS=OFF -DBUILD_EXTRAS=OFF -DBUILD_PYBULLET=OFF \
    -DCMAKE_CXX_FLAGS="$CFLAGS_COMMON -DBT_USE_DOUBLE_PRECISION" -DCMAKE_C_FLAGS="$CFLAGS_COMMON"
  ninja -C "$SRC/bullet3/$BUILD_DIR" BulletDynamics BulletCollision BulletSoftBody LinearMath
  find "$SRC/bullet3/$BUILD_DIR" \( -name 'libBullet*.a' -o -name 'libLinearMath.a' \) -exec cp -f {} "$DW/lib/" \;
}

# --- RecastNavigation (static) -> libRecast/Detour/DetourCrowd/DetourTileCache/DebugUtils.a
build_recast() {
  log "recast"
  emcmake cmake -S "$SRC/recast" -B "$SRC/recast/$BUILD_DIR" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DBUILD_SHARED_LIBS=OFF \
    -DRECASTNAVIGATION_DEMO=OFF -DRECASTNAVIGATION_TESTS=OFF -DRECASTNAVIGATION_EXAMPLES=OFF \
    -DCMAKE_CXX_FLAGS="$CFLAGS_COMMON" -DCMAKE_C_FLAGS="$CFLAGS_COMMON"
  ninja -C "$SRC/recast/$BUILD_DIR" Recast Detour DetourCrowd DetourTileCache DebugUtils
  find "$SRC/recast/$BUILD_DIR" -name 'lib*.a' -exec cp -f {} "$DW/lib/" \;
}

# --- MyGUI (engine only, static) -> libMyGUIEngineStatic.a  (+ headers into deps/wasm/include)
# --- SDL2 cmake config shim. The emscripten SDL2 PORT ships sdl2-config.cmake but no
# sdl2-config-version.cmake, so CMake reads its version as "unknown" and OpenMW's
# find_package(SDL2 2.0.20) rejects it — while the port is actually SDL 2.32.10, far newer than
# required. Nothing is wrong but the missing file, so supply one and forward to the port.
build_sdl2_cfg() {
  log "sdl2 cmake config shim"
  local V H OUT="$DW/lib/cmake/SDL2"
  H="$SR/include/SDL2/SDL_version.h"
  V="$(awk '/define SDL_MAJOR_VERSION/{a=$3} /define SDL_MINOR_VERSION/{b=$3} /define SDL_PATCHLEVEL/{c=$3} END{print a"."b"."c}' "$H")"
  [ -n "$V" ] && [ "$V" != ".." ] || { echo "!! could not read SDL version from $H" >&2; return 1; }
  mkdir -p "$OUT"
  # Read from the header rather than hardcoded, so a toolchain bump cannot leave a lie here.
  cat > "$OUT/SDL2Config.cmake" <<CFG
include("$SR/lib/cmake/SDL2/sdl2-config.cmake")
set(SDL2_VERSION "$V")
CFG
  cat > "$OUT/SDL2ConfigVersion.cmake" <<CFG
set(PACKAGE_VERSION "$V")
if("\${PACKAGE_VERSION}" VERSION_LESS "\${PACKAGE_FIND_VERSION}")
  set(PACKAGE_VERSION_COMPATIBLE FALSE)
else()
  set(PACKAGE_VERSION_COMPATIBLE TRUE)
  if("\${PACKAGE_VERSION}" VERSION_EQUAL "\${PACKAGE_FIND_VERSION}")
    set(PACKAGE_VERSION_EXACT TRUE)
  endif()
endif()
CFG
  echo "staged SDL2 cmake config for $V"
}

build_mygui() {
  log "mygui"
  # MyGUI needs FreeType, from the emscripten port. VERIFIED 2026-08-24: cmake DOES find it, but
  # only once the port has been materialised into the sysroot — a port does not exist as a .a
  # until something links it, so build_em_ports must have run first (it now builds this set).
  # Without that, configure fails at "Could NOT find Freetype (missing: FREETYPE_LIBRARY)" while
  # cheerfully reporting the headers were found, which is a confusing place to land.
  local FT="-sUSE_FREETYPE=1"
  # MyGUI's UString is std::basic_string<unsigned short>, and libc++ only specialises char_traits
  # for the standard character types — newer releases removed the primary template it relied on,
  # so 3.4.3 no longer compiles as-is. Force-include a forwarding specialisation rather than
  # patching upstream. See deps/shim/ushort_char_traits.h for why this is safe.
  local SHIM=""
  [ -f "$ROOT/deps/shim/ushort_char_traits.h" ] && SHIM="-include $ROOT/deps/shim/ushort_char_traits.h"
  emcmake cmake -S "$SRC/mygui" -B "$SRC/mygui/$BUILD_DIR" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DMYGUI_STATIC=ON -DMYGUI_RENDERSYSTEM=1 -DMYGUI_DISABLE_PLUGINS=ON \
    -DMYGUI_BUILD_DEMOS=OFF -DMYGUI_BUILD_TOOLS=OFF -DMYGUI_BUILD_PLUGINS=OFF \
    -DMYGUI_BUILD_UNITTESTS=OFF -DMYGUI_BUILD_TEST_APP=OFF -DMYGUI_DONT_USE_OBSOLETE=ON \
    -DCMAKE_CXX_FLAGS="$CFLAGS_COMMON $FT $SHIM" -DCMAKE_C_FLAGS="$CFLAGS_COMMON $FT"
  # MyGUIEngine, NOT MyGUIEngineStatic. MYGUI_STATIC=ON changes the library TYPE, not the target
  # NAME — 3.4.3 has no MyGUIEngineStatic target at all, so this failed with "unknown target"
  # every time. (It had never been run: the VERIFY note above was still standing.)
  ninja -C "$SRC/mygui/$BUILD_DIR" MyGUIEngine
  find "$SRC/mygui/$BUILD_DIR" -name 'libMyGUIEngine*.a' -exec cp -f {} "$DW/lib/" \;
  # Headers OpenMW's configure expects under MYGUI_HOME=$DW (include/MYGUI/*).
  mkdir -p "$DW/include/MYGUI"
  cp -f "$SRC/mygui/MyGUIEngine/include/"*.h "$DW/include/MYGUI/" 2>/dev/null || true
}

# --- FFmpeg 6 (bink video + game audio: mp3/pcm/vorbis, static) -> libav*/libsw*.a (into $DW)
build_ffmpeg() {
  log "ffmpeg"
  arch_guard "$SRC/ffmpeg-6.1.2" make distclean
  cd "$SRC/ffmpeg-6.1.2"
  emconfigure ./configure \
    --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
    --enable-cross-compile --target-os=none --arch=$WASM_ARCH \
    --disable-x86asm --disable-inline-asm --disable-asm \
    --disable-everything --disable-programs --disable-doc --disable-network \
    --disable-pthreads --disable-autodetect --disable-shared --enable-static \
    `# Bink is the VIDEO codec. The rest is GAME AUDIO: Morrowind ships music and voice as mp3 and`  \
    `# sound effects as PCM wav. FFmpegDecoder is the ONLY decoder OpenMW has -- it serves`          \
    `# soundmanagerimp.cpp:175 for every sound, not just video -- so without these`                  \
    `# avcodec_find_decoder() returns null for every non-video asset and the game is silent.`        \
    --enable-decoder=bink,binkaudio_dct,binkaudio_rdft,mp3,pcm_s16le,pcm_u8,pcm_s24le,vorbis \
    --enable-demuxer=bink,mp3,wav,ogg --enable-parser=mpegaudio \
    --enable-protocol=file \
    `# --extra-ldflags is NOT redundant with --extra-cflags. ffmpeg configure compiles its` \
    `# probe with the cflags but LINKS it with only the ldflags, so under -m64 the object` \
    `# came out wasm64 and the link stayed wasm32:` \
    `#   wasm-ld: error: test.o: must specify -mwasm64 to process wasm64 object files` \
    `# which configure reports only as the generic "C compiler test failed".` \
    `# Empty on wasm32, so that path is unchanged.` \
    --extra-cflags="$CFLAGS_COMMON" --extra-ldflags="$ARCH_FLAG" --prefix="$DW"
  emmake make -j"$JOBS"
  emmake make install         # stages libav*/libsw*.a + headers into $DW
}

# --- Boost (program_options + iostreams, static) -> libboost_program_options/iostreams.a
build_boost() {
  log "boost"   ### VERIFY ### emscripten b2 toolset wiring is the fiddliest of the set.
  arch_guard "$SRC/boost_1_85_0" rm -rf bin.v2
  cd "$SRC/boost_1_85_0"
  ./bootstrap.sh --with-libraries=program_options,iostreams || ./bootstrap.sh
  # Point b2 at em++ via a user-config so it cross-compiles.
  printf 'using clang : emscripten : em++ : <cxxflags>"%s" <archiver>emar <ranlib>emranlib ;\n' \
    "$CFLAGS_COMMON" > "$SRC/boost_1_85_0/user-config-em.jam"
  ./b2 --user-config="$SRC/boost_1_85_0/user-config-em.jam" toolset=clang-emscripten \
    link=static runtime-link=static threading=multi variant=release \
    --with-program_options --with-iostreams \
    --prefix="$DW" -j"$JOBS" install
  # (OpenMW's configure sets Boost_DIR=$DW/lib/cmake/Boost-1.85.0 and Boost_INCLUDE_DIR=$SRC/boost_1_85_0)
}

# --- Lua 5.4 (static, no interpreter/compiler) -> liblua.a  (+ headers)
build_lua() {
  log "lua"
  cd "$SRC/lua-5.4.7/src"
  rm -f ./*.o
  # Compile every core/lib .c except the standalone driver (lua.c) and compiler (luac.c).
  for c in *.c; do case "$c" in lua.c|luac.c) ;; *) emcc $CFLAGS_COMMON -c "$c" -o "${c%.c}.o";; esac; done
  emar rcs "$DW/lib/liblua.a" $(ls *.o | grep -vE '^(lua|luac)\.o$')
  cp -f lua.h luaconf.h lualib.h lauxlib.h ../src/lua.hpp "$DW/include/" 2>/dev/null || \
    cp -f lua.h luaconf.h lualib.h lauxlib.h "$DW/include/"
}

# --- LZ4 (static) -> liblz4.a (+ headers)
build_lz4() {
  log "lz4"
  arch_guard "$SRC/lz4-1.10.0" make -C lib clean
  cd "$SRC/lz4-1.10.0"
  emmake make -C lib CC=emcc AR=emar CFLAGS="$CFLAGS_COMMON" liblz4.a
  stage_lib lib/liblz4.a
  cp -f lib/lz4.h lib/lz4hc.h lib/lz4frame.h "$DW/include/" 2>/dev/null || true
}

# --- OpenAL stub: an EMPTY archive. Satisfies CMake's find_library for OPENAL_LIBRARY and
#     LUA_MATH_LIBRARY; the real OpenAL is emscripten's built-in `-lopenal` at link time.
build_openal_stub() {
  log "openal_stub (empty)"
  local o; o="$(mktemp -d)/oastub.o"
  echo 'int _openmw_openal_stub = 0;' | emcc $CFLAGS_COMMON -x c - -c -o "$o"
  emar rcs "$DW/lib/libopenal_stub.a" "$o"
}

# --- OSG (the hardest; already scripted). Requires the patch applied to deps/src/osg first:
#     cd deps/src/osg && git apply "$ROOT/wasm-build/patches/osg-emscripten.patch"
build_osg() { log "osg (-> build-osg.sh)"; ROOT="$ROOT" EM_LIBEXEC="$EM_LIBEXEC" OMW_WASM64="${OMW_WASM64:-0}" bash "$ROOT/wasm-build/build-osg.sh"; }

# --- Emscripten-provided sysroot libs: multithreaded ICU (libicu_*-mt.a) + libGL-getprocaddr.a.
#     These are emscripten ports/embuilder outputs referenced by explicit sysroot path in
#     link-openmw.sh, so they must exist pre-link.
#     ### VERIFY ### exact embuilder target names + ICU port invocation vary by emscripten version
#     (`emcc --show-ports`, `embuilder --help`). Building a tiny -pthread program that pulls each port
#     is the version-robust way to force them into the sysroot cache as the -mt variants.
build_em_ports() {
  log "emscripten ports (ICU-mt, libGL-getprocaddr)"
  local t; t="$(mktemp -d)"
  echo 'int main(){return 0;}' > "$t/p.c"
  emcc $ARCH_FLAG -pthread -sMAX_WEBGL_VERSION=2 -sFULL_ES3=1 "$t/p.c" -o "$t/gl.js"    # GL -> libGL-getprocaddr.a
  echo 'int main(){return 0;}' > "$t/i.c"
  emcc $ARCH_FLAG -pthread -sUSE_ICU=1 "$t/i.c" -o "$t/icu.js"                          # ICU port -> libicu_*-mt.a
  # The rest of the ports OpenMW and MyGUI link. A port is only materialised into the sysroot
  # when something links it, so building them here is what lets MyGUI's FindFreetype succeed —
  # and what makes link-openmw.sh's -sUSE_* flags resolve without a surprise rebuild.
  echo 'int main(){return 0;}' > "$t/r.c"
  emcc $ARCH_FLAG -pthread -sUSE_SDL=2 -sUSE_FREETYPE=1 -sUSE_HARFBUZZ=1 -sUSE_LIBPNG=1        -sUSE_LIBJPEG=1 -sUSE_ZLIB=1 -sUSE_OGG=1 -sUSE_VORBIS=1 "$t/r.c" -o "$t/r.js"
  # FATAL if the sysroot archives aren't staged — otherwise build-deps reports success and the
  # failure only surfaces much later as a cryptic link-openmw.sh "file not found" (or links a stale
  # cached variant). (Previously `emcc ... || true` + `ls ... || echo` masked this and returned 0.)
  # Re-resolve after the ports have been built: LIBGL was probed before this ran.
  LIBGL="$GLDIR/libGL-getprocaddr.a"; [ -f "$LIBGL" ] || LIBGL="$GLDIR/libGL-mt-getprocaddr.a"
  log "GL archive: ${LIBGL##*/}"
  ls -1 "$LIBGL" "$SR/lib/$WASM_ARCH-emscripten/"libicu_*-mt.a >/dev/null 2>&1 || {
    echo "!! ICU-mt / libGL-getprocaddr not staged — see VERIFY note above" >&2; exit 1; }
}

ALL=(em_ports openal_stub sdl2_cfg lz4 lua boost bullet recast mygui ffmpeg osg)
targets=("${@:-${ALL[@]}}")
for t in "${targets[@]}"; do "build_${t}"; done
log "done. staged libs:"; ls "$DW/lib/"*.a | wc -l
