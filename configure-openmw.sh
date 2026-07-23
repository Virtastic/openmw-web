#!/bin/bash
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
# Configure OpenMW for WebAssembly against our cross-compiled dep stack.
set -e
# ROOT and the emscripten libexec dir are env-overridable so this runs both locally (macOS/Homebrew
# defaults below) and inside the CI builder image (which exports ROOT + EM_LIBEXEC).
ROOT="${ROOT:-$(cd "$(dirname "$0")" && pwd)}"
DW=$ROOT/deps/wasm
EM_LIBEXEC="${EM_LIBEXEC:-/opt/homebrew/Cellar/emscripten/6.0.1/libexec}"
SR="$EM_LIBEXEC/cache/sysroot"
W32=$SR/lib/wasm32-emscripten
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
emcmake cmake -S "$ROOT/openmw" -B "$ROOT/build-wasm" -G Ninja \
  -DMYGUI_STATIC=ON -DUSE_LUAJIT=OFF -DOSG_STATIC=ON -DOPENMW_USE_SYSTEM_OSG=ON -DOSGPlugins_LIB_DIR="$DW/lib" -DCMAKE_CXX_SCAN_FOR_MODULES=OFF \
  -DSDL2_DIR="$DW/lib/cmake/SDL2" \
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
  -DCMAKE_CXX_FLAGS="-D_LIBCPP_ENABLE_CXX17_REMOVED_FEATURES -DBT_USE_DOUBLE_PRECISION -fwasm-exceptions -include $DW/include/mygui_char_traits_fix.h -include $DW/include/gl_compat.h -Wno-missing-template-arg-list-after-template-kw -Wno-error=missing-template-arg-list-after-template-kw -pthread -I$BOOST/../bullet3/src -I$DW/include -I$BOOST" \
  -DCMAKE_C_FLAGS="-pthread" \
  -DBoost_INCLUDE_DIR="$BOOST" -DBoost_NO_BOOST_CMAKE=OFF \
  -DBoost_USE_STATIC_RUNTIME=ON -DBoost_USE_STATIC_LIBS=ON \
  -DBoost_DIR="$DW/lib/cmake/Boost-1.85.0" \
  -DLUA_LIBRARIES="$DW/lib/liblua.a" -DLUA_LIBRARY="$DW/lib/liblua.a" -DLUA_INCLUDE_DIR="$DW/include" \
  -DLUA_MATH_LIBRARY="$DW/lib/libopenal_stub.a" \
  -DLZ4_LIBRARY="$DW/lib/liblz4.a" -DLZ4_INCLUDE_DIR="$DW/include" \
  -DOPENAL_LIBRARY="$DW/lib/libopenal_stub.a" -DOPENAL_INCLUDE_DIR="$SR/include/AL" \
  -DCMAKE_EXE_LINKER_FLAGS="-fwasm-exceptions -lopenal --use-port=sdl2 --use-port=freetype --use-port=harfbuzz --use-port=libpng --use-port=libjpeg --use-port=zlib --use-port=ogg --use-port=vorbis -sALLOW_MEMORY_GROWTH=1 -sMAX_WEBGL_VERSION=2 -sFULL_ES3=1 -sEXIT_RUNTIME=0 -sPTHREAD_POOL_SIZE=8 -sINITIAL_MEMORY=1610612736 -sASSERTIONS=0" \
  -DZLIB_LIBRARY="$W32/libz.a" -DZLIB_INCLUDE_DIR="$SR/include" \
  -DOPENGL_INCLUDE_DIR="$SR/include" \
  -DOPENGL_opengl_LIBRARY="$W32/libGL-getprocaddr.a" \
  -DOPENGL_glx_LIBRARY="$W32/libGL-getprocaddr.a" \
  -DOPENGL_gl_LIBRARY="$W32/libGL-getprocaddr.a" \
  -DOPENGL_egl_LIBRARY="$W32/libGL-getprocaddr.a" \
  -DOPENGL_GLES2_LIBRARY="$W32/libGL-getprocaddr.a" \
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
