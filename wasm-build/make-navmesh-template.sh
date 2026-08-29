#!/bin/bash
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
#
# Build a prebuilt navmesh.db for [simPeer] navmeshTemplate (F15).
#
# WHY THIS EXISTS. The sim peer already caches navmesh to <user-data>/navmesh.db, and a warm
# restart regenerates NOTHING -- measured on the peer image, cold vs warm sharing one user-data
# dir:
#
#     cold (empty user-data) : 138 collision shapes added, navmesh.db grows to 3.55 MB
#     warm (same user-data)  :   0 collision shapes added, navmesh.db byte-identical
#
# So the engine's own cache is a complete substitute for the "offline navmesh generation" F15
# originally asked for -- no Recast pipeline, no new format, no client/server contract change.
#
# The gap it does NOT close is that every world gets its own user-data dir on purpose (two worlds
# must not share one, server.ts), so each newly spawned world pays the cold cost again, and the
# gateway spawns and idle-reaps worlds continuously. Seeding each new world from one prebuilt db
# closes that, and server.ts does the copy.
#
# COPIED PER WORLD, never shared: openmw disables writes when it sees another process on the same
# navmeshdb ("writes to navmeshdb are disabled to avoid concurrent writes from multiple
# processes", asyncnavmeshupdater.cpp), which would leave every world after the first unable to
# extend its own cache.
#
# USAGE
#   wasm-build/make-navmesh-template.sh <gamedata-dir> <output.db> [cell] [seconds]
#
#   gamedata-dir  a Morrowind Data Files directory (the .esm + .bsa set)
#   output.db     where to write the template; point [simPeer] navmeshTemplate at it
#   cell          cell key or name to sit in while generating (default: the Balmora exterior)
#   seconds       how long to let the peer run (default 300)
#
# COVERAGE IS WHAT YOU EXPLORE. The peer only generates tiles near where it is, so this produces a
# warm cache for that area, not the whole province -- the 3.55 MB above is one cell's surroundings.
# Run longer, or run repeatedly against the same output with different cells, to widen it: the db
# accumulates, so each run adds to what is already there.
set -euo pipefail

GAMEDATA="${1:?usage: make-navmesh-template.sh <gamedata-dir> <output.db> [cell] [seconds]}"
OUTPUT="${2:?usage: make-navmesh-template.sh <gamedata-dir> <output.db> [cell] [seconds]}"
CELL="${3:--2,-9}"
SECONDS_TO_RUN="${4:-300}"
IMAGE="${OMW_SIMPEER_IMAGE:-openmw-simpeer:local}"

[ -d "$GAMEDATA" ] || { echo "FATAL: no such gamedata dir: $GAMEDATA" >&2; exit 1; }
ls "$GAMEDATA"/[Mm]orrowind.esm >/dev/null 2>&1 \
  || { echo "FATAL: $GAMEDATA has no Morrowind.esm -- this wants a Data Files directory" >&2; exit 1; }

# pwd -W FIRST, and this matters on Windows. Under Git Bash a plain `pwd` returns the MSYS form
# (/c/Users/...), which docker does NOT recognise as a host path -- it silently creates an
# ANONYMOUS VOLUME instead, so the run reports success and the output file never appears on the
# host. `pwd -W` gives the Windows form docker actually mounts; it does not exist on Linux,
# hence the fallback.
OUT_DIR="$(cd "$(dirname "$OUTPUT")" && { pwd -W 2>/dev/null || pwd; })"
OUT_NAME="$(basename "$OUTPUT")"

# Seed from an existing template if one is already there, so repeated runs ACCUMULATE tiles
# instead of each starting from nothing.
SEED_ARG=""
if [ -f "$OUTPUT" ]; then
  echo "=== existing template found ($(stat -c%s "$OUTPUT" 2>/dev/null || echo ?) bytes) -- extending it"
  SEED_ARG="yes"
fi

echo "=== generating navmesh: cell=$CELL for ${SECONDS_TO_RUN}s using $IMAGE"

# --user root: the peer image runs as an unprivileged user that cannot write the /out mount.
MSYS_NO_PATHCONV=1 docker run --rm \
  --user root \
  -v "$(cd "$GAMEDATA" && { pwd -W 2>/dev/null || pwd; }):/gamedata:ro" \
  -v "$OUT_DIR:/out" \
  -e OPENMW_HEADLESS=1 \
  -e OSG_THREADING=SingleThreaded \
  "$IMAGE" sh -c '
    set -e
    mkdir -p /tmp/pc /tmp/pu
    RES=$(dirname $(command -v openmw))/../share/openmw/resources
    # Mirrors buildPeerCfg() (server/src/core/gamedata.ts): data=, content= in load order,
    # fallback-archive= per BSA, resources=. Deliberately NOT declaring builtin.omwscripts --
    # openmw loads that implicitly and declaring it aborts with "Content file specified more
    # than once".
    { echo "data=/gamedata"
      for esm in Morrowind.esm Tribunal.esm Bloodmoon.esm; do
        [ -f "/gamedata/$esm" ] && echo "content=$esm"
      done
      for bsa in Morrowind.bsa Tribunal.bsa Bloodmoon.bsa; do
        [ -f "/gamedata/$bsa" ] && echo "fallback-archive=$bsa"
      done
      echo "resources=$RES"
    } > /tmp/pc/openmw.cfg
    # Extend the existing template rather than starting cold, when one was passed in.
    [ -n "'"$SEED_ARG"'" ] && cp "/out/'"$OUT_NAME"'" /tmp/pu/navmesh.db || true
    timeout '"$SECONDS_TO_RUN"' openmw --config /tmp/pc --replace config --user-data /tmp/pu \
      --skip-menu --start "'"$CELL"'" --no-sound > /tmp/peer.log 2>&1 || true
    if [ ! -f /tmp/pu/navmesh.db ]; then
      echo "FATAL: the peer produced no navmesh.db -- last log lines:" >&2
      tail -20 /tmp/peer.log >&2
      exit 1
    fi
    echo "shapes added this run: $(grep -c "collision shape to navmeshdb" /tmp/peer.log || true)"
    cp /tmp/pu/navmesh.db "/out/'"$OUT_NAME"'"
  '

echo "=== wrote $OUTPUT ($(stat -c%s "$OUTPUT" 2>/dev/null || echo ?) bytes)"
echo "Point [simPeer] navmeshTemplate at it; server.ts copies it into each new world's user-data."
