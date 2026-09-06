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

# A COMMAND PASSED TO `docker run` RUNS INSTEAD OF THE SERVER.
#
# This image had no ENTRYPOINT until the mode switch landed, so `docker run <image> node
# /bots/healthcheck.mjs ...` simply replaced the CMD and ran node. With an entrypoint those
# words arrive here as "$@" instead, and the branches below append them to the server's own
# argument list — so the protocol health check in .github/workflows/deploy-mp.yml handed
# `node /bots/healthcheck.mjs` to the gateway as positional arguments and parseArgs killed it.
# Caught by that check on a real production deploy; the server itself was up and serving.
#
# The ordinary docker idiom: anything that is not a flag is a command to exec verbatim. Flags
# (and no arguments at all) fall through to the mode selection and are forwarded to the server,
# which is what the compose files rely on.
DATA="${OMW_DATA:-/data}"

# ------------------------------------------------------------------ ownership repair
#
# THE TWO IMAGES DO NOT AGREE ON A UID, AND THE COMPOSE FILE TELLS YOU TO SWITCH BETWEEN THEM.
#
# The self-hosted image runs as `node` (uid 1000, from the node base); the image with the
# engine runs as `app` (uid 1001, from useradd on ubuntu). Following docker-compose.yml's own
# advice -- "switch the build block below to the simpeer file when you want a world people can
# actually join" -- therefore handed a data directory written by one user to a process running
# as the other, and every file in it became unreadable. The server does not start: it dies on
# EACCES opening /data/blob-secret, which reads like a corrupt install rather than a uid
# change. Renumbering either image would have broken whichever deployments already had data
# owned the other way, including production.
#
# So the uid is made not to matter. Each image names its own runtime user in OMW_RUN_AS and
# starts as root; this repairs ownership when it is actually wrong, then drops privileges for
# good. Recursive chown only when the top of the tree is already wrong -- /data/gamedata is
# thousands of files and hundreds of megabytes, and paying for that on every boot to change
# nothing is not free.
#
# The drop must EXEC, never fork: this process is PID 1, and the dashboard's restart button
# works by the server exiting cleanly on SIGTERM. `su` would fork and swallow the signal.
RUN_AS="${OMW_RUN_AS:-}"
if [ -n "$RUN_AS" ] && [ "$(id -u)" = "0" ]; then
  WANT_UID="$(id -u "$RUN_AS" 2>/dev/null || echo '')"
  WANT_GID="$(id -g "$RUN_AS" 2>/dev/null || echo '')"
  if [ -n "$WANT_UID" ]; then
    HAVE_UID="$(stat -c %u "$DATA" 2>/dev/null || echo '')"
    if [ -n "$HAVE_UID" ] && [ "$HAVE_UID" != "$WANT_UID" ]; then
      echo "{\"event\":\"entrypoint.chown\",\"dir\":\"$DATA\",\"from\":$HAVE_UID,\"to\":$WANT_UID}"
      # Best effort: a read-only mount is a legitimate deployment, and the server reports an
      # unwritable data dir far better than a failed chown does.
      chown -R "$WANT_UID:$WANT_GID" "$DATA" 2>/dev/null ||         echo "{\"event\":\"entrypoint.chown_failed\",\"dir\":\"$DATA\",\"note\":\"read-only mount, or not permitted\"}"
    fi
    # Re-enter this script as the runtime user. The second pass sees a non-root id and falls
    # straight through to the mode selection below.
    if command -v su-exec >/dev/null 2>&1; then
      exec su-exec "$WANT_UID:$WANT_GID" "$0" "$@"
    elif command -v setpriv >/dev/null 2>&1; then
      exec setpriv --reuid="$WANT_UID" --regid="$WANT_GID" --clear-groups -- "$0" "$@"
    elif command -v gosu >/dev/null 2>&1; then
      exec gosu "$WANT_UID:$WANT_GID" "$0" "$@"
    else
      echo "{\"event\":\"entrypoint.no_privilege_drop\",\"note\":\"no su-exec/setpriv/gosu; STAYING ROOT\"}" >&2
    fi
  fi
fi

# A COMMAND PASSED TO `docker run` RUNS INSTEAD OF THE SERVER. Placed after the drop above so
# it runs as the runtime user too, exactly as it did when the image pinned USER.
case "${1:-}" in
  '' | -*) ;;
  *) exec "$@" ;;
esac
# WHAT THIS IMAGE RUNS WHEN NOBODY HAS CHOSEN. The self-hosted image ships 'single' (one
# person, one game, the common case); the hosted platform image ships 'gateway' in its
# Dockerfile, because that is what it has always run and a deploy must not silently move a
# live platform onto a different program. The MARKER still wins over both, which is what
# makes the setup wizard's answer mean something on either image.
MODE="${OMW_DEFAULT_MODE:-single}"
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
    # SAY WHICH PROGRAM THIS CONTAINER IS, in both branches. Only the gateway one announced
    # itself, so 'which mode did this start in?' was answerable from the log for one of the two
    # answers and had to be inferred for the other.
    echo "{\"event\":\"entrypoint.mode\",\"mode\":\"single\"}"
    exec node --max-old-space-size="$HEAP" dist/server.mjs --data "$DATA" "$@"
    ;;
esac
