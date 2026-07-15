# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-wasm
# syntax=docker/dockerfile:1
# =============================================================================================
# Per-push deploy image for morrowind.virtastic.app.
#  - builder stage: incremental OpenMW→WASM build (fast, FROM the prebaked openmw-builder image).
#  - runtime stage: caddy:alpine serving the web root with the app's serving contract.
# Built + tagged `morrowind:ovh` by .github/workflows/deploy-ovh.yml on the Virtastic self-hosted runner.
# =============================================================================================

# ---- builder ---------------------------------------------------------------------------------
FROM openmw-builder:1 AS builder
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
RUN \
    # Hermetic guard: fsroot/gamedata (the ?nomw demo) is gitignored, so a clean actions/checkout
    # omits it and the link would silently bake an EMPTY demo (green build, broken ?nomw). Fail loud
    # instead — the build context must carry the rsynced gamedata.
    { test -n "$(ls -A fsroot/gamedata 2>/dev/null)" || { echo 'FATAL: fsroot/gamedata is missing/empty — the ?nomw demo would bake empty. Ensure it is rsynced into the build context.' >&2; exit 1; }; } \
 && bash configure-openmw.sh \
 && ninja -C build-wasm components openmw-lib \
 && bash wasm-build/link-openmw.sh \
 && mkdir -p play \
 && cp build-wasm/openmw.js build-wasm/openmw.wasm build-wasm/openmw.data play/ \
 && bash wasm-build/make_br.sh

# ---- runtime ---------------------------------------------------------------------------------
FROM caddy:2-alpine AS runtime
# Web root: the built engine artifacts (raw + .br — both needed; Range uses raw, full GET uses .br)
# plus the tracked HTML/JS. The demo dataset is mounted at /srv/data by docker-compose.prod.yml.
# Static web files straight from the build context (editing them = a fast runtime-only rebuild).
COPY play/index.html play/launcher.html play/streamfs.js /srv/
# Built engine artifacts from the builder stage (raw + .br).
COPY --from=builder /build/play/openmw.js      /build/play/openmw.js.br      /srv/
COPY --from=builder /build/play/openmw.wasm    /build/play/openmw.wasm.br    /srv/
COPY --from=builder /build/play/openmw.data    /build/play/openmw.data.br    /srv/

COPY deploy/Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
