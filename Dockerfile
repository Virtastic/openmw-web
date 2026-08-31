# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
# syntax=docker/dockerfile:1
# =============================================================================================
# Per-push deploy image for morrowind.virtastic.app.
#  - builder stage: incremental openmw-web build (fast, FROM the prebaked openmw-builder image).
#  - runtime stage: caddy:alpine serving the web root with the app's serving contract.
# Built + tagged `morrowind:ovh` by .github/workflows/deploy-ovh.yml on the Virtastic self-hosted runner.
# =============================================================================================

# ---- builder ---------------------------------------------------------------------------------
# BUILDER_IMAGE selects the pointer model, because that is ALL that differs between the two
# builds from this file's point of view:
#   openmw-builder:1    -> wasm32 (default, unchanged)
#   openmw-builder64:1  -> wasm64/MEMORY64 (Dockerfile.builder64)
# The wasm64 image sets ENV OMW_WASM64=1 itself, and configure-openmw.sh / link-openmw.sh read
# that to pick deps/wasm64, the wasm64 sysroot and -m64. So there is deliberately no second
# build recipe here to drift out of sync with this one.
ARG BUILDER_IMAGE=openmw-builder:1
FROM ${BUILDER_IMAGE} AS builder
# ROOT + EM_LIBEXEC drive configure-openmw.sh; EMSDK_BIN drives link-openmw.sh (emcc/em++ + sysroot).
ENV ROOT=/build EM_LIBEXEC=/emsdk/upstream/emscripten EMSDK_BIN=/emsdk/upstream/emscripten
WORKDIR /build

# Engine source + build recipe (deps/ already baked into openmw-builder).
COPY openmw            /build/openmw
COPY fsroot            /build/fsroot
COPY wasm-build        /build/wasm-build
COPY configure-openmw.sh /build/configure-openmw.sh
# NOTE: the static play/*.html + streamfs.js are copied in the RUNTIME stage (from context), NOT here
# — editing them must not invalidate this compile layer and trigger a full ~13-min recompile.

# configure → FULL clean compile → out-of-band link (emits openmw.{js,wasm,data}, preloads fsroot@/)
# → brotli siblings. Mirrors the local build (configure-openmw.sh + wasm-build/{link-openmw.sh,make_br.sh}).
# NOTE: NO build-wasm cache mount — deliberately. Docker COPY preserves source mtimes, so a cache mount
# holding objects from a prior run made ninja report "no work to do" and LINK STALE OBJECTS into a
# broken openmw.wasm (null-function crash at runtime) even though the source had changed. A clean
# compile every build (~13 min) is slower but deterministic and correct — non-negotiable for releases.
# PARALLELISM IS MEMORY-BOUND, NOT CORE-BOUND. ninja defaults to nproc+2, which on the 32-core
# builder means 34 concurrent clang processes against 15.5 GB of RAM. OpenMW translation units
# peak around 1-2 GB each, so the box runs out and the kernel OOM killer takes the largest
# process it can find -- which is Jenkins itself:
#
#   oom-kill: ... global_oom, task=java
#   Out of memory: Killed process 388785 (java)
#
# The build then dies with "exit code -1" and no compiler error, because nothing was wrong with
# the code -- the CI server was killed underneath it. Two builds were lost to this before the
# kernel log was read.
#
# 8 fits comfortably at ~1-2 GB a job. Override BUILD_JOBS on a bigger box, and budget by RAM
# rather than by core count.
ARG BUILD_JOBS=8
RUN \
    # Hermetic guard: fsroot/gamedata (the ?nomw demo) is gitignored, so a clean actions/checkout
    # omits it and the link would silently bake an EMPTY demo (green build, broken ?nomw). Fail loud
    # instead — the build context must carry the rsynced gamedata.
    { test -n "$(ls -A fsroot/gamedata 2>/dev/null)" || { echo 'FATAL: fsroot/gamedata is missing/empty — the ?nomw demo would bake empty. Ensure it is rsynced into the build context.' >&2; exit 1; }; } \
 && bash configure-openmw.sh \
 `# build-wasm32 or build-wasm64, chosen by OMW_WASM64 in configure-openmw.sh. Resolved here` \
 `# rather than hardcoded so the two models cannot share a tree and swap stale objects.` \
 && BUILD_DIR="$([ "${OMW_WASM64:-0}" = 1 ] && echo build-wasm64 || echo build-wasm)" \
 && ninja -C "$BUILD_DIR" -j "${BUILD_JOBS:-8}" components openmw-lib \
 && bash wasm-build/link-openmw.sh \
 && mkdir -p play \
 && cp "$BUILD_DIR"/openmw.js "$BUILD_DIR"/openmw.wasm "$BUILD_DIR"/openmw.data play/ \
 && bash wasm-build/make_br.sh

# ---- runtime ---------------------------------------------------------------------------------
FROM caddy:2-alpine AS runtime
# Web root: the built engine artifacts (raw + .br — both needed; Range uses raw, full GET uses .br)
# plus the tracked HTML/JS. The demo dataset is mounted at /srv/data by docker-compose.prod.yml.
# Static web files straight from the build context.
# og.png is the social card the OG/Twitter tags in launcher.html point at; robots.txt carries
# the Sitemap line (Cloudflare prepends its managed AI-crawler block to whatever we serve).
COPY play/index.html play/launcher.html play/streamfs.js /srv/
COPY play/og.png play/robots.txt play/sitemap.xml /srv/
# Built engine artifacts from the builder stage (raw + .br).
COPY --from=builder /build/play/openmw.js      /build/play/openmw.js.br      /srv/
COPY --from=builder /build/play/openmw.wasm    /build/play/openmw.wasm.br    /srv/
COPY --from=builder /build/play/openmw.data    /build/play/openmw.data.br    /srv/

# Content-version the engine: move openmw.{js,wasm,data}(+.br) into /srv/e/<hash>/ and stamp that hash
# into /srv/index.html, so Cloudflare can never serve a mismatched mix of two builds (the null-function
# crash). Alpine busybox has sh/sed/sha256sum. index.html stays no-cache and points at the current dir.
COPY wasm-build/version-engine.sh /tmp/version-engine.sh
RUN PLAY=/srv sh /tmp/version-engine.sh && rm /tmp/version-engine.sh

COPY deploy/Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
