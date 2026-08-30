#!/bin/bash
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
# Precompress the big compressible payloads for play/server.py's .br fast path.
# Run after every deploy (openmw.js/wasm/data change); the .esm files never change.
# Skips already-fresh .br files. Audio/video tars (mp3/bik) barely compress — skipped.
set -euo pipefail
ROOT="${ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# Two qualities, because the two file classes have opposite economics.
# ENGINE_Q: openmw.{js,wasm,data} are compressed ONCE per release and then served to every visitor,
#   so spend the CPU -- q11 buys ~10-20% over q5 on wasm, which is pure first-load win forever.
# Q: the 100MB+ ESMs and the tar, where q11 costs many minutes for a much smaller relative gain.
ENGINE_Q="${ENGINE_Q:-11}"
Q="${Q:-5}"

for f in "$ROOT"/play/openmw.js "$ROOT"/play/openmw.wasm "$ROOT"/play/openmw.data \
         "$ROOT"/play/mwdata/Morrowind.esm "$ROOT"/play/mwdata/Tribunal.esm \
         "$ROOT"/play/mwdata/Bloodmoon.esm "$ROOT"/play/mwdata/mwextra.tar; do
  [ -f "$f" ] || continue
  if [ -f "$f.br" ] && [ "$f.br" -nt "$f" ]; then
    echo "fresh: $f.br"
    continue
  fi
  case "${f##*/}" in
    openmw.js|openmw.wasm|openmw.data) q="$ENGINE_Q" ;;
    *)                                 q="$Q" ;;
  esac
  echo "brotli -q $q: $f"
  brotli -f -q "$q" -o "$f.br" "$f"
done
# Summary only — never fail the script here (mwdata/*.br is absent in the CI build context, and
# under `set -euo pipefail` a non-zero ls would abort the whole build).
ls -lh "$ROOT"/play/*.br "$ROOT"/play/mwdata/*.br 2>/dev/null | awk '{print $5, $9}' || true
