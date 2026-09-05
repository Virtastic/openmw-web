#!/bin/sh
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
#
# Picks which server this container runs, from a marker the setup wizard writes.
#
#   single  (default) one game, dist/server.mjs
#   gateway           the multiplayer server, dist/gateway.mjs, which runs one game process
#                     per player inside THIS container — no extra orchestration needed
#
# The wizard writes the marker when the operator chooses single player or multiplayer (the
# setup route in net/admin/routes.ts) and asks for a restart; the container comes back on the
# other entry point. Both programs serve the dashboard at /admin, so the switch is a button
# on the same page in both directions. That is the whole mechanism.
set -e

DATA="${OMW_DATA:-/data}"
MODE="single"
if [ -f "$DATA/.mode" ]; then
  MODE="$(tr -d '[:space:]' < "$DATA/.mode")"
fi

# Heap cap well under the compose mem_limit so the process degrades (GC pressure) rather
# than getting OOM-killed mid-flush.
HEAP="${OMW_HEAP_MB:-256}"

case "$MODE" in
  gateway)
    # DIFFERENT ARGUMENTS, not just a different entry point. The gateway supervises many
    # world processes, so it takes --worlds (where their data dirs go), --shared (the one
    # dir holding accounts and config that every world reads) and --base-port (the range it
    # allocates world ports from). It has no --data at all, and passing one makes it exit on
    # an unknown option — which is exactly what the first version of this script did.
    echo "{\"event\":\"entrypoint.mode\",\"mode\":\"gateway\"}"
    exec node --max-old-space-size="$HEAP" dist/gateway.mjs \
      --worlds "$DATA/worlds" --shared "$DATA" \
      --port "${OMW_PORT:-8080}" --base-port "${OMW_BASE_PORT:-9000}" "$@"
    ;;
  *)
    # Anything unrecognised falls through to single-world rather than refusing to start: a
    # typo in a marker file must never be the reason a server does not come up.
    if [ "$MODE" != "single" ]; then
      echo "{\"event\":\"entrypoint.unknown_mode\",\"mode\":\"$MODE\",\"using\":\"single\"}"
    fi
    exec node --max-old-space-size="$HEAP" dist/server.mjs --data "$DATA" "$@"
    ;;
esac
