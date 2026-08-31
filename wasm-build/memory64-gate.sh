#!/bin/bash
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
# Build and run the MEMORY64 gate (wasm-build/memory64-gate.cpp).
#
# Runs under node rather than a browser, deliberately: node IS V8, so it answers every
# question the gate asks (threads, >4 GiB, exceptions, the pointer ABI) without a server, a
# COOP/COEP origin or a CDP harness. The browser half -- crossOriginIsolated and
# SharedArrayBuffer -- is already proven by the shipping engine and is re-checked in Chrome by
# memory64-gate-browser.mjs once this passes.
#
# Uses the emscripten/emsdk:6.0.1 image directly. The engine's own openmw-builder image is NOT
# needed and must not be used: the whole point is to test the toolchain BEFORE the dependency
# stack is rebuilt against it.
#
# Usage: bash wasm-build/memory64-gate.sh [--wasm32]
#   --wasm32   build the same program for wasm32, as the A/B control
set -euo pipefail

ROOT="${ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
IMAGE="${EMSDK_IMAGE:-emscripten/emsdk:6.0.1}"
OUT="$ROOT/build-memory64-gate"

MEM64=1
SUFFIX="64"
BROWSER=0
case "${1:-}" in
  --wasm32)  MEM64=0; SUFFIX="32" ;;
  --browser) BROWSER=1; SUFFIX="web64" ;;
esac

mkdir -p "$OUT"

# Flags mirror wasm-build/link-openmw.sh:165-227 as closely as a standalone program can. The
# ones that matter are -pthread (shared memory), -fwasm-exceptions (legacy wasm EH; the engine
# forbids -flto and -sWASM_LEGACY_EXCEPTIONS=0), -msimd128 and -sMALLOC=mimalloc. INITIAL_MEMORY
# is the engine's 1.5 GB so the growth path being exercised is the real one.
FLAGS=(
  -O2
  -fwasm-exceptions
  -msimd128
  -pthread
  -sPTHREAD_POOL_SIZE=8
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=1610612736
  -sMALLOC=mimalloc
  -sEXIT_RUNTIME=0
  -sMODULARIZE=1
  -sEXPORT_NAME=createGate
  `# wasmMemory: Phase 4 sizes the new ceiling off wasmMemory.buffer.byteLength, so the gate`
  `# has to prove that value is readable -- and that growth kept it a SharedArrayBuffer.`
  -sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','UTF8ToString','stringToNewUTF8','wasmMemory']
  -sEXPORTED_FUNCTIONS=['_main','_malloc','_free','_gate_set_clipboard','_gate_get_clipboard']
)

# -m64, NOT -sMEMORY64=1: emscripten 6.0.1 accepts both but warns that the -s form is
# deprecated ("prefer the standard -m64 or --target=wasm64 flags"). -m64 is also a clang-style
# flag rather than a linker setting, so it flows through CMAKE_C_FLAGS/CMAKE_CXX_FLAGS and
# CMake's try_compile probes the same way -msimd128 and -pthread already do.
if [ "$BROWSER" = "1" ]; then
  # -sENVIRONMENT=web,worker matches link-openmw.sh:191. The browser build is served
  # cross-origin isolated by memory64-gate-browser.mjs.
  FLAGS+=(-m64 -sMAXIMUM_MEMORY=8589934592 -sENVIRONMENT=web,worker)
elif [ "$MEM64" = "1" ]; then
  # 8 GiB: past the wasm32 wall, and the first sane step up. Chrome caps wasm memory at 16 GiB
  # but play/index.html:1607-1629 already tiers on navigator.deviceMemory, so the ceiling the
  # engine ships is a separate decision (see Phase 4) -- here it only has to clear 4 GiB.
  FLAGS+=(-m64 -sMAXIMUM_MEMORY=8589934592)
else
  FLAGS+=(-sMAXIMUM_MEMORY=4294967296)
fi

echo "==> building memory64-gate (wasm$SUFFIX) with $IMAGE"
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$ROOT:/src" -w /src \
  "$IMAGE" \
  em++ "${FLAGS[@]}" \
    wasm-build/memory64-gate.cpp \
    -o "build-memory64-gate/gate$SUFFIX.js"

if [ "$BROWSER" = "1" ]; then
  echo "==> running gate in headless Chrome"
  node "$ROOT/wasm-build/memory64-gate-browser.mjs" "$OUT"
else
  echo "==> running gate (wasm$SUFFIX) under node $(node --version)"
  node "$ROOT/wasm-build/memory64-gate-run.mjs" "$OUT/gate$SUFFIX.js" "$MEM64"
fi
