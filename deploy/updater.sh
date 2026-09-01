#!/bin/sh
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
#
# The update agent. Runs in its own container (see Dockerfile.updater), holds the docker
# socket, and does exactly one thing: when the dashboard's owner clicks Update, check out
# the newest release tag and rebuild the server container.
#
# SECURITY STANCE. The docker socket is root on the host, so this container is not
# reachable from the web at all - no ports, not behind the proxy. Its only input is the
# existence of a flag file the server writes into ./data. The file's CONTENT is never
# executed or interpolated into any command: the tag to check out is computed here, from
# `git tag` itself, so a compromised web container could at worst make us build a release
# that GitHub already published.
#
# The agent updates only the openmw-web service. It never recreates itself mid-run; a
# newer updater image applies the next time the operator runs setup or
# `docker compose up -d --build` by hand.

set -u

REPO=/repo
DATA="$REPO/data"
FLAG="$DATA/update-requested"
STATUS="$DATA/update-status.json"
AGENT="$DATA/update-agent.json"
LOCK="$DATA/update-lock"

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# One line, JSON-safe: every control character flattened to a space (JSON forbids them raw,
# and build output is full of tabs and ANSI escapes - one of those in an error field would
# make the whole status file unparseable, hiding the very failure it reports), then
# backslashes and quotes escaped.
esc() { printf '%s' "$1" | tr '[:cntrl:]' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# All status files are written temp+mv so the server never reads a half-written JSON.
write_json() {
  printf '%s\n' "$2" > "$1.tmp" && mv -f "$1.tmp" "$1"
}

heartbeat() { # $1 = true|false, $2 = reason when not ready
  write_json "$AGENT" "{\"at\":\"$(now_iso)\",\"ready\":$1,\"reason\":\"$(esc "${2:-}")\"}"
}

START_AT=''
TAG=''
PHASE=''
status() { # $1 = phase, $2 = error (optional)
  PHASE="$1"
  write_json "$STATUS" "{\"phase\":\"$1\",\"tag\":\"$(esc "$TAG")\",\"startedAt\":\"$START_AT\",\"updatedAt\":\"$(now_iso)\",\"error\":\"$(esc "${2:-}")\"}"
}

# Run a step, streaming its output to our log; on failure, mark the status failed with the
# tail of that output so the dashboard can show WHY without anyone needing a shell.
#
# The step runs in the background so this loop can keep the heartbeat and the status file
# FRESH while it works: a compose build can run well past ten minutes (the simpeer engine
# compile is ~13), and a status whose updatedAt froze at the phase transition reads as a
# dead updater and a stuck build to the dashboard, both wrongly.
OUT=/tmp/updater-step.out
run_step() { # $1 = label for the failure message, then the command
  label="$1"; shift
  "$@" > "$OUT" 2>&1 &
  step_pid=$!
  while kill -0 "$step_pid" 2>/dev/null; do
    heartbeat true
    status "$PHASE"
    sleep 20
  done
  if wait "$step_pid"; then
    cat "$OUT"
    return 0
  fi
  cat "$OUT"
  status failed "$label failed: $(tail -c 1500 "$OUT")"
  return 1
}

do_update() {
  START_AT=$(now_iso)
  TAG=''

  # Compose names its project after the current directory, which in here is "repo" - not
  # whatever the host called it. Reuse the running container's own project name so we
  # update THAT deployment instead of colliding with its fixed container_name.
  PROJ=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' openmw-web 2>/dev/null || true)
  [ -n "$PROJ" ] && export COMPOSE_PROJECT_NAME="$PROJ"

  # The newest published release tag, computed HERE - the flag file names a tag too, but
  # only for the audit log. Deployments run releases, nothing else.
  status pulling
  run_step "fetching tags" git -C "$REPO" fetch --tags --force origin || return
  TAG=$(git -C "$REPO" tag --sort=-v:refname | head -n 1)
  case "$TAG" in
    v*) ;;
    *) status failed "no release tags found after fetching"; return ;;
  esac
  if ! printf '%s' "$TAG" | grep -Eq '^v[0-9A-Za-z.-]{1,32}$'; then
    status failed "the newest tag has an unexpected name"; return
  fi
  run_step "checking out $TAG" git -C "$REPO" -c advice.detachedHead=false checkout "refs/tags/$TAG" || return

  # Build first, restart after: a failed build leaves the old image and the running
  # container completely untouched.
  status building
  run_step "building" docker compose build openmw-web || return

  # The only step that can leave the service down; the dashboard is already showing its
  # "waiting for the server to come back" screen by now.
  status restarting
  run_step "restarting" docker compose up -d openmw-web || return

  status done
}

cd "$REPO" || { heartbeat false "cannot enter /repo"; sleep 30; exec sh "$0"; }

while :; do
  # Heartbeat first, every loop, unconditionally: the dashboard's "is the updater alive"
  # question is answered by this file being fresh, not by anything working.
  if [ ! -d "$REPO/.git" ]; then
    heartbeat false "/repo is not a git checkout"
  elif ! grep -q '^REPO_DIR=' "$REPO/.env" 2>/dev/null; then
    heartbeat false "REPO_DIR is not set in .env (run setup.sh / setup.ps1 once)"
  else
    heartbeat true

    if [ -f "$FLAG" ]; then
      # A concurrent run guard, mkdir-atomic. A lock left by a crash is stolen after 30
      # minutes rather than wedging updates forever.
      if [ -d "$LOCK" ]; then
        age=$(( $(date +%s) - $(stat -c %Y "$LOCK" 2>/dev/null || echo 0) ))
        [ "$age" -gt 1800 ] && rmdir "$LOCK" 2>/dev/null
      fi
      if mkdir "$LOCK" 2>/dev/null; then
        # Consume the flag BEFORE acting - a crash mid-update must not fire again on the
        # next loop. Its content is logged for the audit trail and used for nothing else.
        flag_age=$(( $(date +%s) - $(stat -c %Y "$FLAG" 2>/dev/null || echo 0) ))
        echo "update requested: $(cat "$FLAG" 2>/dev/null | head -c 500)"
        rm -f "$FLAG"
        if [ "$flag_age" -gt 900 ]; then
          # A request nobody is watching any more (server restarted with a flag pending,
          # clock skew, a crashed run). Firing a surprise restart is worse than asking
          # the owner to click again.
          START_AT=$(now_iso); TAG=''
          status failed "the request expired before the updater saw it; click Update again"
        else
          do_update
        fi
        rmdir "$LOCK" 2>/dev/null
      fi
    fi
  fi
  sleep 30
done
