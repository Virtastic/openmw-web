#!/bin/bash
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
#
# G3: the three s43 arms, back to back, so they share contention conditions.
#
# Running them at different times is what produced the first (unusable) set of numbers:
# host load moved between 14 and 131 across the session, which swamps the effect being
# measured. Back to back on an idle box is the only way the arms are comparable — and even
# then s43 records the host load per row so a contaminated row can be spotted rather than
# reasoned about.
#
#   ./wasm-build/measure-avatar-cost.sh [steps]     (default 8,16,32,48,64)
#
# Read the MARGINAL cost per avatar, not the absolute fps: the marginal figure survives
# moderate contention, the absolute does not.
set -euo pipefail
cd "$(dirname "$0")/.."

STEPS="${1:-8,16,32,48,64}"
OUT="${OUT:-/tmp/omw-avatar-cost}"
mkdir -p "$OUT"

echo "== host load before: $(uptime | sed 's/.*load/load/')"
echo "== swap: $(sysctl -n vm.swapusage)"
echo

# 1. CONTROL: every avatar fully simulated (pre-G2 behaviour).
# 2. ALL-FAR: everyone degraded — the ceiling the LOD buys.
# 3. CROWD: everyone inside the near radius so only the cap bounds cost. This is the
#    shipping shape and the one that decides the published per-cell number.
run_arm() {
  local name="$1"; shift
  echo "== arm: $name"
  env "$@" S43_STEPS="$STEPS" S43_SAMPLE_MS=8000 \
    node wasm-build/mp-harness.mjs s43 2>&1 | tee "$OUT/$name.log" \
    | grep -E "avatars \||^\s+[0-9]+ \||avatars:|PASS|FAIL" || true
  echo
}

run_arm control S43_RENDER_LOD=full
run_arm allfar  S43_RENDER_LOD=tiered S43_LOD_RADIUS=0
run_arm crowd   S43_RENDER_LOD=tiered S43_LOD_RADIUS=999999 S43_NEAR_MAX=12

echo "== host load after: $(uptime | sed 's/.*load/load/')"
echo "logs in $OUT"
