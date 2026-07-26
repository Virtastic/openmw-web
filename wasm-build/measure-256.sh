#!/bin/bash
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
#
# F2: what does a world of 256 actually cost? Replaces the arithmetic in the F2 task with
# numbers. Three runs, because they answer three different questions and only the first is
# the realistic one:
#
#   spread   256 players over 16 cells — how a world actually looks. Expected to be cheap:
#            the spatial index made broadcaster cost linear, and 200 spread measured
#            1.66 ms/tick.
#   onecell  all 256 in one cell — inherently N^2 and the pathological case. Extrapolated at
#            ~34 ms of a 66 ms tick (~52% of one core); this run is what confirms or refutes
#            that, and Node being single-threaded makes it the process ceiling.
#   client   the browser ramp, which is where the REAL limit is expected: each puppet is an
#            NPC object with a generated record and equipment, so 256 against a ~1.5 GB WASM
#            heap should fail on MEMORY rather than on frame time. Watch RSS, not just fps.
#
# Run on an IDLE box. The last set of capacity figures published from a contended machine
# were an order of magnitude wrong; `uptime` is printed around every phase so a contaminated
# run is visible rather than quietly believed.
set -uo pipefail
cd "$(dirname "$0")/.."

OUT="${OUT:-/tmp/omw-256}"
mkdir -p "$OUT"
BOTS="${BOTS:-256}"

banner() { echo; echo "=== $1  [load:$(uptime | sed 's/.*load average[s]*://')]"; }

banner "1/3 spread: $BOTS bots over 16 cells"
(cd server && npm run soak -- --bots "$BOTS" --minutes 8 --cells 16) 2>&1 | tee "$OUT/spread.log" \
  | grep -E "^\[soak\] (t=|PASS|FAIL|RSS|ping|ERROR)|^\[step\]|^ *[0-9]+ \|" || true

banner "2/3 one cell: $BOTS bots co-located (pathological)"
(cd server && npm run soak -- --bots "$BOTS" --minutes 5 --onecell) 2>&1 | tee "$OUT/onecell.log" \
  | grep -E "^\[soak\] (t=|PASS|FAIL|RSS|ping|ERROR)|^\[step\]|^ *[0-9]+ \|" || true

banner "3/3 client ramp: browser client vs 96 then 128 avatars"
# Stops at 128 deliberately: if the heap wall is real it will show here, and pushing to 256
# would just crash the tab without telling us where the edge is.
S43_STEPS=32,64,96,128 S43_SAMPLE_MS=8000 \
  node wasm-build/mp-harness.mjs s43 2>&1 | tee "$OUT/client.log" \
  | grep -E "avatars:|puppetTiers|PASS|FAIL|Assertion" || true

banner "done"
echo "logs in $OUT"
