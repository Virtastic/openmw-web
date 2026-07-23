#!/bin/bash
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
# Build OpenSceneGraph 3.6.5 for WASM (the hardest dependency).
#
# Prereqs: OSG source at $ROOT/deps/src/osg (branch OpenSceneGraph-3.6.5) with
# wasm-build/patches/osg-emscripten.patch applied:
#   cd deps/src/osg && git apply ../../..//wasm-build/patches/osg-emscripten.patch
#
# The patch contains ALL emscripten fixes: FrameBufferObject.cpp RTT drawBuffers
# (GL_COLOR_ATTACHMENT0 vs GL_NONE — do NOT lose this, it un-blanks every RTT camera),
# GLExtensions.cpp (S3TC + packed-depth-stencil forced on), State.cpp (force VBO+VAO),
# Texture.cpp (skip LOD-bias/anisotropy/border-color/swizzle enums invalid on WebGL2),
# tristripper graph_array.h (mem_fun_ref -> lambda; file is latin1-encoded), and the
# fixed-function-emulation touch-ups in Fog/Light/Material/PolygonMode/TexMat.
#
# Key configure facts:
# - -fwasm-exceptions is REQUIRED (throw in a static initializer compiles to
#   `unreachable` without it -> boot trap in __wasm_call_ctors).
# - OSG_CPP_EXCEPTIONS_AVAILABLE=ON (GLES profile defaults it OFF, which kills
#   the png plugin among other things).
# - GL/EGL/GLES libs all point at emscripten's libGL-getprocaddr.a.
set -euo pipefail

ROOT="${ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# Honor the EM_LIBEXEC the caller exports (build-deps.sh:146) so the CI/Linux builder — where
# emscripten lives under a different prefix — finds libGL. Falls back to the local Homebrew path.
EM_LIBEXEC="${EM_LIBEXEC:-/opt/homebrew/Cellar/emscripten/6.0.1/libexec}"
SYSROOT_LIBGL="$EM_LIBEXEC/cache/sysroot/lib/wasm32-emscripten/libGL-getprocaddr.a"
SRC="$ROOT/deps/src/osg"
BUILD="$SRC/build-wasm"

mkdir -p "$BUILD" && cd "$BUILD"

emcmake cmake .. \
  -G Ninja \
  -DBUILD_OSG_APPLICATIONS:BOOL=OFF \
  -DBUILD_OSG_EXAMPLES:BOOL=OFF \
  -DCMAKE_BUILD_TYPE:STRING=Release \
  -DCMAKE_CXX_FLAGS:STRING="-D_LIBCPP_ENABLE_CXX17_REMOVED_FEATURES -D_LIBCPP_ENABLE_CXX20_REMOVED_FEATURES -Wno-invalid-utf8 -pthread -fwasm-exceptions -msimd128 -fno-strict-aliasing -fno-strict-overflow" \
  -DCMAKE_C_FLAGS:STRING="-pthread -fwasm-exceptions -msimd128 -fno-strict-aliasing -fno-strict-overflow" \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DDYNAMIC_OPENSCENEGRAPH:BOOL=OFF \
  -DDYNAMIC_OPENTHREADS:BOOL=OFF \
  -DEGL_LIBRARY:FILEPATH="$SYSROOT_LIBGL" \
  -DGLESV2_LIBRARY="$SYSROOT_LIBGL" \
  -DOPENGL_PROFILE:STRING=GLES2 \
  -DOPENGL_egl_LIBRARY="$SYSROOT_LIBGL" \
  -DOPENGL_gl_LIBRARY="$SYSROOT_LIBGL" \
  -DOSG_CPP_EXCEPTIONS_AVAILABLE:BOOL=ON \
  -DOSG_GL1_AVAILABLE:BOOL=OFF \
  -DOSG_GL2_AVAILABLE:BOOL=OFF \
  -DOSG_GL3_AVAILABLE:BOOL=OFF \
  -DOSG_GLES2_AVAILABLE:BOOL=ON \
  -DOSG_GL_DISPLAYLISTS_AVAILABLE:BOOL=OFF \
  -DOSG_GL_FIXED_FUNCTION_AVAILABLE:BOOL=OFF \
  -DOSG_GL_MATRICES_AVAILABLE:BOOL=OFF \
  -DOSG_GL_VERTEX_ARRAY_FUNCS_AVAILABLE:BOOL=OFF \
  -DOSG_GL_VERTEX_FUNCS_AVAILABLE:BOOL=OFF \
  -DOSG_WINDOWING_SYSTEM:STRING=X11

# Core libs + the plugins OpenMW links (osgdb_serializers_osg is many targets; build all).
ninja osg osgUtil osgDB osgGA osgViewer osgAnimation osgFX osgParticle osgShadow osgSim osgText OpenThreads \
      osgdb_bmp osgdb_dds osgdb_freetype osgdb_jpeg osgdb_osg osgdb_png osgdb_tga || ninja

# Collect outputs where the OpenMW link expects them.
cp -f lib/*.a "$ROOT/deps/wasm/lib/"
echo "OSG libs staged into $ROOT/deps/wasm/lib"
