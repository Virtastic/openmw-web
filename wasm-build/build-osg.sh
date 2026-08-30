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
#
# WHY THE PROFILE IS `GLES2+GLES3` (F50, resolved 2026-08-28).
# The runtime target is WebGL2, which IS OpenGL ES 3.0 -- link-openmw.sh says so twice
# (-sMIN_WEBGL_VERSION=2, -sFULL_ES3=1). This was configured GLES2, and that had a price:
# GLExtensions.cpp:760 gates isVAOSupported on OSG_GLES3_FEATURES, which the GLES2 profile never
# defines, so VAO support read false and osg-emscripten.patch had to force it true. Anything that
# then went near the DisplaySettings VAO path trapped with `null function`, because the capability
# was forced on while glGenVertexArrays/glBindVertexArray were still resolved through
# getProcAddress. DisplaySettings likewise picked SHADER_GLES2 rather than SHADER_GLES3.
#
# A pure `-DOPENGL_PROFILE=GLES3` does NOT build. Image.cpp / Texture.cpp / Texture2DArray.cpp /
# Texture3D.cpp fail with `use of undeclared identifier 'GL_RED' / 'GL_GREEN' / 'GL_BLUE' /
# 'GL_UNPACK_ROW_LENGTH'`. Those are valid ES 3.0 tokens -- the ES3-only path wants GLES3/gl3.h and
# every GL library here points at libGL-getprocaddr.a, which brings the GLES2 headers implicitly.
#
# `GLES2+GLES3` is the fix: OSG defines BOTH feature macros, so the ES3 gates (isVAOSupported,
# SHADER_GLES3) resolve honestly while the GLES2 headers still satisfy the tokens above. Verified:
# deps/wasm/include/osg/GL carries `#define OSG_GLES3_FEATURES 1`, OSG builds clean, engine boots.
#
# This did NOT turn into a frame-time win, and that is worth recording rather than rediscovering:
# osg-emscripten.patch already forces _forceVertexArrayObject in State::State(), so VAOs were
# always being bound. See the F48 note in apps/openmw/engine.cpp for the measurement.
set -euo pipefail

ROOT="${ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# Honor the EM_LIBEXEC the caller exports (build-deps.sh:146) so the CI/Linux builder — where
# emscripten lives under a different prefix — finds libGL. Falls back to the local Homebrew path.
EM_LIBEXEC="${EM_LIBEXEC:-/opt/homebrew/Cellar/emscripten/6.0.1/libexec}"
SYSROOT_LIBGL="$EM_LIBEXEC/cache/sysroot/lib/wasm32-emscripten/libGL-getprocaddr.a"
SRC="$ROOT/deps/src/osg"
BUILD="$SRC/build-wasm"

mkdir -p "$BUILD" && cd "$BUILD"

# TWO THINGS THE PORT LAYOUT BREAKS, both the same shape as the MyGUI/Freetype fault.
#
# PNG_LIBRARY: under -pthread the emscripten port is built as libpng-mt.a, and CMake's FindPNG
# looks for libpng.a / libpng16.a — so it reports "found version 1.6.58" (the headers) and
# "missing: PNG_LIBRARY" in the same breath, never generates the osgdb_png target, and the
# target list below then dies with "unknown target 'osgdb_png'".
#
# -Wno-register: OSG's flex-generated ConfigLexer.cpp still declares 'register', which C++17
# makes an ERROR rather than a warning. -Wno-deprecated-register is the C++11 spelling and does
# not cover it. This only bites through the "|| ninja" fallback (which builds every plugin) —
# but that fallback is precisely what runs whenever anything above is missing.
emcmake cmake .. \
  -G Ninja \
  -DBUILD_OSG_APPLICATIONS:BOOL=OFF \
  -DBUILD_OSG_EXAMPLES:BOOL=OFF \
  -DCMAKE_BUILD_TYPE:STRING=Release \
  -DPNG_LIBRARY:FILEPATH="$EM_LIBEXEC/cache/sysroot/lib/wasm32-emscripten/libpng-mt.a" \
  -DCMAKE_CXX_FLAGS:STRING="-D_LIBCPP_ENABLE_CXX17_REMOVED_FEATURES -D_LIBCPP_ENABLE_CXX20_REMOVED_FEATURES -Wno-invalid-utf8 -Wno-register -pthread -fwasm-exceptions -msimd128 -fno-strict-aliasing -fno-strict-overflow" \
  -DCMAKE_C_FLAGS:STRING="-pthread -fwasm-exceptions -msimd128 -fno-strict-aliasing -fno-strict-overflow" \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DDYNAMIC_OPENSCENEGRAPH:BOOL=OFF \
  -DDYNAMIC_OPENTHREADS:BOOL=OFF \
  -DEGL_LIBRARY:FILEPATH="$SYSROOT_LIBGL" \
  -DGLESV2_LIBRARY="$SYSROOT_LIBGL" \
  -DOPENGL_PROFILE:STRING=GLES2+GLES3 \
  -DOPENGL_egl_LIBRARY="$SYSROOT_LIBGL" \
  -DOPENGL_gl_LIBRARY="$SYSROOT_LIBGL" \
  -DOSG_CPP_EXCEPTIONS_AVAILABLE:BOOL=ON \
  -DOSG_GL1_AVAILABLE:BOOL=OFF \
  -DOSG_GL2_AVAILABLE:BOOL=OFF \
  -DOSG_GL3_AVAILABLE:BOOL=OFF \
  -DOSG_GLES2_AVAILABLE:BOOL=ON \
  -DOSG_GLES3_AVAILABLE:BOOL=ON \
  -DOSG_GL_DISPLAYLISTS_AVAILABLE:BOOL=OFF \
  -DOSG_GL_FIXED_FUNCTION_AVAILABLE:BOOL=OFF \
  -DOSG_GL_MATRICES_AVAILABLE:BOOL=OFF \
  -DOSG_GL_VERTEX_ARRAY_FUNCS_AVAILABLE:BOOL=OFF \
  -DOSG_GL_VERTEX_FUNCS_AVAILABLE:BOOL=OFF \
  -DOSG_WINDOWING_SYSTEM:STRING=X11

# Core libs + the plugins OpenMW links.
#
# THE SERIALIZERS ARE NAMED EXPLICITLY. The old comment said "osgdb_serializers_osg is many
# targets; build all" and relied on the `|| ninja` fallback to catch them — so whenever the
# explicit list SUCCEEDED they were silently skipped, and OpenMW then failed configure with
# OSGPlugins_osgdb_serializers_osg_LIBRARY=<not found>. A fallback that only runs on failure
# cannot be where a required target lives.
#
# `|| ninja` is kept as a genuine last resort, but it now builds every plugin including ones
# that need -Wno-register (see the flags above).
ninja osg osgUtil osgDB osgGA osgViewer osgAnimation osgFX osgParticle osgShadow osgSim osgText OpenThreads \
      osgdb_bmp osgdb_dds osgdb_freetype osgdb_jpeg osgdb_osg osgdb_png osgdb_tga \
      osgdb_serializers_osg osgdb_serializers_osganimation osgdb_serializers_osgfx \
      osgdb_serializers_osgga osgdb_serializers_osgmanipulator osgdb_serializers_osgparticle \
      osgdb_serializers_osgshadow osgdb_serializers_osgsim osgdb_serializers_osgtext \
      osgdb_serializers_osgterrain osgdb_serializers_osgvolume || ninja

# Collect outputs where the OpenMW link expects them.
cp -f lib/*.a "$ROOT/deps/wasm/lib/"

# ...AND THE HEADERS. Only the libs were staged, so find_package(OpenSceneGraph) failed with
# "Could NOT find OpenSceneGraph (missing: OSG_FOUND OPENTHREADS_FOUND)" even though every .a was
# present — README already documents deps/wasm/include as holding OSG 3.6.5, so this step was
# simply missing.
#
# BOTH trees are needed: the source include/ has the API, and the BUILD tree's include/ has the
# generated osg/Config and osg/Version that encode which GL profile this build was configured
# for. Staging only the source tree gives a header set that does not describe this build.
mkdir -p "$ROOT/deps/wasm/include"
cp -R "$SRC/include/." "$ROOT/deps/wasm/include/"
cp -R "$BUILD/include/." "$ROOT/deps/wasm/include/"
echo "OSG libs + headers staged into $ROOT/deps/wasm"
