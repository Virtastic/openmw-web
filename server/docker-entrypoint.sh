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
# Write the marker and restart; the container comes back on the other entry point. That is
# the whole mechanism.
#
# THE ADMIN DASHBOARD DOES NOT RUN IN GATEWAY MODE. gateway/main.ts serves the world
# directory and the front door, not /admin — the things the dashboard administers (roster,
# moderation, mods, settings) belong to a world process, and the gateway has none of its own.
# Verified by switching a container and getting a 404.
#
# So this is deliberately NOT exposed as a button in the dashboard: switching would make the
# dashboard disappear, and switching back means editing this marker over a shell, which is
# precisely the lockout the rest of this design works to avoid. It is a marker file for
# whoever is already on the box. If the dashboard ever needs to work here, the admin routes
# have to be mounted in gateway/main.ts first.
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
