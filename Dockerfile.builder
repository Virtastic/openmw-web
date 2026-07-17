# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
# openmw-builder — one-time builder image that bakes the emscripten toolchain + the WASM dep stack so
# the per-push deploy build (Dockerfile) is just the fast incremental OpenMW compile+link.
#
# This is the PREBUILT-deps path (what built the live morrowind.virtastic.app image): it stages the
# already-cross-compiled deps/wasm + the sysroot ICU/-mt libs+headers + the dep source HEADERS
# (bullet3/src, boost), pre-builds the emscripten ports, and rewrites macOS build-machine paths.
# wasm .a archives are host-arch-independent, so ARM-built libs link fine here (x86 Linux).
# Prereqs in the build context (rsync'd; all gitignored): deps/wasm, deps/sysroot-extra
# (lib .a + include/unicode), deps/src/{bullet3/src,boost_1_85_0/boost}.
# Build once on the VPS: docker build -t openmw-builder:1 -f Dockerfile.builder .
# (For a fully-from-source rebuild of the deps instead of prebuilt, see wasm-build/build-deps.sh.)
# TODO if the toolchain changes: repin the emscripten/emsdk tag to match (emcc --version).
FROM emscripten/emsdk:6.0.1
RUN apt-get update && apt-get install -y --no-install-recommends ninja-build brotli git pkg-config && rm -rf /var/lib/apt/lists/*
ENV ROOT=/build EM_LIBEXEC=/emsdk/upstream/emscripten
WORKDIR /build
COPY deps/wasm /build/deps/wasm
COPY deps/sysroot-extra /build/sysroot-extra
# Stage the prebuilt ICU (-mt libs + libGL) into the sysroot lib dir, the ICU headers into the sysroot
# include dir, fix the .pc prefixes, and rewrite macOS build-machine paths in the cmake/pkgconfig configs.
RUN SR=/emsdk/upstream/emscripten/cache/sysroot \
 && cp /build/sysroot-extra/*.a "$SR/lib/wasm32-emscripten/" \
 && cp -R /build/sysroot-extra/include/unicode "$SR/include/" \
 && sed -i 's#^prefix=.*#prefix=/build/deps/wasm#' /build/deps/wasm/lib/pkgconfig/*.pc \
 && ( grep -rlZ -e "/opt/homebrew/Cellar/emscripten/6.0.1/libexec/cache/sysroot" -e "/Users/mstavridis/Downloads/CS-Web" /build/deps/wasm/lib/cmake /build/deps/wasm/lib/pkgconfig 2>/dev/null | xargs -0 -r sed -i -e 's#/opt/homebrew/Cellar/emscripten/6.0.1/libexec/cache/sysroot#/emsdk/upstream/emscripten/cache/sysroot#g' -e 's#/Users/mstavridis/Downloads/CS-Web#/build#g' ) ; true
# Pre-build the emscripten ports (non-pthread + pthread) so find_package + link resolve them.
RUN printf 'int main(){return 0;}\n' > /tmp/p.c \
 && emcc          -sUSE_SDL=2 -sUSE_FREETYPE=1 -sUSE_HARFBUZZ=1 -sUSE_LIBPNG=1 -sUSE_LIBJPEG=1 -sUSE_ZLIB=1 -sUSE_OGG=1 -sUSE_VORBIS=1 /tmp/p.c -o /tmp/p1.js \
 && emcc -pthread -sUSE_SDL=2 -sUSE_FREETYPE=1 -sUSE_HARFBUZZ=1 -sUSE_LIBPNG=1 -sUSE_LIBJPEG=1 -sUSE_ZLIB=1 -sUSE_OGG=1 -sUSE_VORBIS=1 /tmp/p.c -o /tmp/p2.js \
 && test -f /emsdk/upstream/emscripten/cache/sysroot/include/unicode/locid.h && echo "ICU headers staged OK"

COPY deps/src /build/deps/src
