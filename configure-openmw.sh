#!/bin/bash
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
# Configure OpenMW for WebAssembly against our cross-compiled dep stack.
set -e
# ROOT and the emscripten libexec dir are env-overridable so this runs both locally (macOS/Homebrew
# defaults below) and inside the CI builder image (which exports ROOT + EM_LIBEXEC).
ROOT="${ROOT:-$(cd "$(dirname "$0")" && pwd)}"
EM_LIBEXEC="${EM_LIBEXEC:-/opt/homebrew/Cellar/emscripten/6.0.1/libexec}"
SR="$EM_LIBEXEC/cache/sysroot"

# --- WASM64 (MEMORY64) -----------------------------------------------------------------------
# OMW_WASM64=1 configures against the wasm64 dependency stack in deps/wasm64 (built by
# wasm-build/build-deps.sh with the same variable). OFF by default, so the shipping wasm32
# configuration is byte-for-byte what it was.
#
# -m64 rather than -sMEMORY64=1: emscripten 6.0.1 warns the -s spelling is deprecated, and -m64
# is a compiler flag, so it reaches CMake try_compile probes -- which matters a great deal here,
# because a probe compiled for the wrong pointer size fails in ways that read like a missing
# dependency rather than a wrong flag.
if [ "${OMW_WASM64:-0}" = "1" ]; then
  WASM_ARCH=wasm64; ARCH_FLAG=-m64; DW=$ROOT/deps/wasm64
else
  WASM_ARCH=wasm32; ARCH_FLAG=;     DW=$ROOT/deps/wasm
fi
WARCH=$SR/lib/$WASM_ARCH-emscripten
# SEPARATE BUILD TREE PER POINTER MODEL. Sharing build-wasm/ between the two would let ninja
# consider wasm32 objects up to date for a wasm64 configure -- the same stale-object fault the
# root Dockerfile:35 refuses a cache mount over, except here wasm-ld catches it at the final
# link after a full compile. wasm32 deliberately KEEPS build-wasm/ so existing trees stay
# valid; only wasm64 gets a new one. OMW_BUILD_DIR overrides for one-off experiments.
BUILD_DIR="${OMW_BUILD_DIR:-$([ "$WASM_ARCH" = wasm64 ] && echo build-wasm64 || echo build-wasm)}"
W32=$WARCH   # legacy name, kept so the -D lines below read unchanged

# GL archive name varies with the build variant: under -pthread the port materialises as
# libGL-mt-getprocaddr.a. The prebaked wasm32 builder image happens to ship every variant, so
# the non-mt name was always found; a freshly-built wasm64 sysroot only has the one that was
# actually built. Probe rather than assume, or CMake reports OPENGL_gl_LIBRARY-NOTFOUND and the
# failure looks like a missing dependency instead of a missing filename.
LIBGL_A="$WARCH/libGL-getprocaddr.a"
[ -f "$LIBGL_A" ] || LIBGL_A="$WARCH/libGL-mt-getprocaddr.a"

BOOST=$ROOT/deps/src/boost_1_85_0

export MYGUI_HOME="$DW"
# FFmpeg is located by OpenMW's FindFFmpeg via pkg-config (the component VERSIONS come from the .pc
# files). Point pkg-config at our cross-built .pc dir so the version check passes — without this the
# clean builder image reports "FFmpeg too old" (empty version). Locally this dir also carries the .pc.
export PKG_CONFIG_PATH="$DW/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
# NOTE: CMAKE_EXE_LINKER_FLAGS below only affects CMake's own compile/link test executables. The
# final openmw.{js,wasm} is linked out-of-band by wasm-build/link-openmw.sh (authoritative). Keep
# INITIAL_MEMORY (1.5 GB) and ASSERTIONS (off) here in sync with that script so a stray cmake-driven
# link can't clobber them with different values.
# PNG_LIBRARY, for the same reason build-osg.sh needs it: under -pthread the emscripten port
# is built as libpng-mt.a, and CMake's FindPNG only looks for libpng.a / libpng16.a. It then
# reports the headers as found and the library as missing in the same breath, and
# FindOSGPlugins fails on a dependency that is very much present.
PNG_A="$WARCH/libpng-mt.a"

# Force-included into every translation unit. These are build INPUTS, so they live in the
# repo — they used to exist only in the maintainer's gitignored deps/wasm/include, which
# meant a clean checkout could not compile a single file ("gl_compat.h file not found").
# A deps/ copy still wins if one is present, so an existing maintainer tree is untouched.
OMW_FORCE_INC="$ROOT/wasm-build/include"
[ -f "$DW/include/gl_compat.h" ] && OMW_FORCE_INC="$DW/include"

emcmake cmake -S "$ROOT/openmw" -B "$ROOT/$BUILD_DIR" -G Ninja \
  -DMYGUI_STATIC=ON -DUSE_LUAJIT=OFF -DOSG_STATIC=ON -DOPENMW_USE_SYSTEM_OSG=ON -DOSGPlugins_LIB_DIR="$DW/lib" -DCMAKE_CXX_SCAN_FOR_MODULES=OFF \
  -DSDL2_DIR="$DW/lib/cmake/SDL2" -DPNG_LIBRARY:FILEPATH="$PNG_A" \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_PREFIX_PATH="$DW;$SR;$SR/include" \
  -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=BOTH -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=BOTH \
  -DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=BOTH -DCMAKE_FIND_ROOT_PATH="$DW;$SR" \
  -DBUILD_OPENMW=ON -DBUILD_LAUNCHER=OFF -DBUILD_OPENCS=OFF -DBUILD_WIZARD=OFF \
  -DBUILD_BSATOOL=OFF -DBUILD_ESMTOOL=OFF -DBUILD_ESSIMPORTER=OFF -DBUILD_NIFTEST=OFF \
  -DBUILD_NAVMESHTOOL=OFF -DBUILD_BULLETOBJECTTOOL=OFF -DBUILD_MWINIIMPORTER=OFF \
  -DBUILD_DOCS=OFF -DBUILD_BENCHMARKS=OFF -DBUILD_UNITTESTS=OFF -DBUILD_COMPONENTS_TESTS=OFF \
  -DBUILD_OPENMW_MP=OFF -DUSE_QT=OFF -DUSE_SYSTEM_TINYXML=OFF \
  -DOPENMW_USE_SYSTEM_SQLITE3=OFF -DOPENMW_USE_SYSTEM_YAML_CPP=OFF -DOPENMW_USE_SYSTEM_ICU=ON \
  `# -msimd128: every hand-built dep (build-deps.sh, build-osg.sh) already compiles with it; the` \
  `# engine's own TUs did not, so skinning/NIF/terrain/mechanics got no autovectorisation at all.` \
  `# F10 (OMW_PROXY=1): compile the emscripten GL path that creates the context itself instead` \
  `# of asking SDL for it. SDL2's emscripten backend goes through EGL, which is hard-wired to` \
  `# the MAIN-THREAD canvas -- proven by stack trace: _eglCreateContext -> Browser.createContext` \
  `# -> getContext on the transferred canvas, which throws once it belongs to the worker.` \
  `# Off by default so the shipping build keeps SDL's context exactly as it is.` \
  -DCMAKE_CXX_FLAGS="${OMW_PROXY:+-DOPENMW_PROXY_GL} -D_LIBCPP_ENABLE_CXX17_REMOVED_FEATURES -DBT_USE_DOUBLE_PRECISION $ARCH_FLAG -fwasm-exceptions -msimd128 -include $OMW_FORCE_INC/mygui_char_traits_fix.h -include $OMW_FORCE_INC/gl_compat.h -Wno-missing-template-arg-list-after-template-kw -Wno-error=missing-template-arg-list-after-template-kw -pthread -I$BOOST/../bullet3/src -I$DW/include -I$BOOST" \
  -DCMAKE_C_FLAGS="-pthread -msimd128 $ARCH_FLAG" \
  -DBoost_INCLUDE_DIR="$BOOST" -DBoost_NO_BOOST_CMAKE=OFF \
  -DBoost_USE_STATIC_RUNTIME=ON -DBoost_USE_STATIC_LIBS=ON \
  -DBoost_DIR="$DW/lib/cmake/Boost-1.85.0" \
  -DLUA_LIBRARIES="$DW/lib/liblua.a" -DLUA_LIBRARY="$DW/lib/liblua.a" -DLUA_INCLUDE_DIR="$DW/include" \
  -DLUA_MATH_LIBRARY="$DW/lib/libopenal_stub.a" \
  -DLZ4_LIBRARY="$DW/lib/liblz4.a" -DLZ4_INCLUDE_DIR="$DW/include" \
  -DOPENAL_LIBRARY="$DW/lib/libopenal_stub.a" -DOPENAL_INCLUDE_DIR="$SR/include/AL" \
  -DCMAKE_EXE_LINKER_FLAGS="$ARCH_FLAG -fwasm-exceptions -lopenal --use-port=sdl2 --use-port=freetype --use-port=harfbuzz --use-port=libpng --use-port=libjpeg --use-port=zlib --use-port=ogg --use-port=vorbis -sALLOW_MEMORY_GROWTH=1 -sMAX_WEBGL_VERSION=2 -sFULL_ES3=1 -sEXIT_RUNTIME=0 -sPTHREAD_POOL_SIZE=8 -sINITIAL_MEMORY=1610612736 -sASSERTIONS=0" \
  -DZLIB_LIBRARY="$W32/libz.a" -DZLIB_INCLUDE_DIR="$SR/include" \
  -DOPENGL_INCLUDE_DIR="$SR/include" \
  -DOPENGL_opengl_LIBRARY="$LIBGL_A" \
  -DOPENGL_glx_LIBRARY="$LIBGL_A" \
  -DOPENGL_gl_LIBRARY="$LIBGL_A" \
  -DOPENGL_egl_LIBRARY="$LIBGL_A" \
  -DOPENGL_GLES2_LIBRARY="$LIBGL_A" \
  -DICU_INCLUDE_DIR="$SR/include" \
  -DICU_UC_LIBRARY_RELEASE="$W32/libicu_common-mt.a" -DICU_UC_LIBRARY="$W32/libicu_common-mt.a" \
  -DICU_I18N_LIBRARY_RELEASE="$W32/libicu_i18n-mt.a" -DICU_I18N_LIBRARY="$W32/libicu_i18n-mt.a" \
  -DICU_DATA_LIBRARY_RELEASE="$W32/libicu_stubdata-mt.a" -DICU_DATA_LIBRARY="$W32/libicu_stubdata-mt.a" \
  -DBULLET_INCLUDE_DIR="$ROOT/deps/src/bullet3/src" -DBULLET_USE_DOUBLE_PRECISION=ON \
  -DBULLET_DYNAMICS_LIBRARY="$DW/lib/libBulletDynamics.a" -DBULLET_COLLISION_LIBRARY="$DW/lib/libBulletCollision.a" \
  -DBULLET_MATH_LIBRARY="$DW/lib/libLinearMath.a" -DBULLET_SOFTBODY_LIBRARY="$DW/lib/libBulletSoftBody.a" \
  `# Skip CheckBulletPrecision.cmake's try_compile probe (flaky under emscripten); our Bullet is` \
  `# built double-precision (-DUSE_DOUBLE_PRECISION=ON). See openmw/cmake/CheckBulletPrecision.cmake.` \
  -DOPENMW_ASSUME_BULLET_DOUBLE_PRECISION:BOOL=TRUE \
  "$@" 2>&1
