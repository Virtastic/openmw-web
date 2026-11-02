#!/bin/sh
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
#
# OT3-14: the image-build step that runs the quest/phase scanner (scan-quests.mjs).
#   build-phase-tables.sh <Data Files dir> <out dir>
# No content file in the data dir (the usual case: Bethesda data cannot be in the repo or a
# public build context) -> writes nothing and succeeds, so a build without data still works.
# Content present -> the scan must succeed, or this exits non-zero and fails the build.
set -eu
DATA="$1"
OUT="$2"
mkdir -p "$OUT"
if [ ! -d "$DATA" ] || ! find "$DATA" -maxdepth 1 -type f -iname '*.esm' | grep -q .; then
  echo "phase tables: no .esm in $DATA, skipping (provide one with --build-context mwdata=<Data Files>)"
  exit 0
fi
node "$(dirname "$0")/scan-quests.mjs" --out-dir "$OUT" --data-dir "$DATA"
for f in phase-cells.json phase-quests.json phase-stages.json script-classes.json; do
  [ -s "$OUT/$f" ] || { echo "phase tables: $f missing after the scan" >&2; exit 1; }
done
