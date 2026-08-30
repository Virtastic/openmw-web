#!/bin/sh
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
#
# Picks which server this container runs, from a marker the dashboard writes.
#
#   single  (default) one world, dist/server.mjs
#   gateway           the multi-world supervisor, dist/gateway.mjs, which spawns worlds as
#                     child processes inside THIS container — no extra orchestration needed
#
# Switching modes in the dashboard writes the marker and restarts; because the restart is a
# SIGTERM the process handles gracefully, and Docker's restart policy brings the container
# back, this script runs again and execs the other entry point. That is the whole mechanism.
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
    echo "{\"event\":\"entrypoint.mode\",\"mode\":\"gateway\"}"
    exec node --max-old-space-size="$HEAP" dist/gateway.mjs --data "$DATA" "$@"
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
