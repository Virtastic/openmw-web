#!/bin/sh
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
#
# One-command setup for a self-hosted openmw-web server, on macOS and Linux.
# Windows has setup.ps1 next to this file.
#
#   ./setup.sh            start the server and open the admin dashboard
#   ./setup.sh --update   pull a newer version and restart
#   ./setup.sh --stop     stop everything (your data is kept)
#
# Plain POSIX sh on purpose: it runs on whatever a fresh mac or a bare Debian box already
# has, with nothing to install first. The whole point is that the FIRST thing an operator
# does cannot itself require setting something up.
set -eu

# ---------------------------------------------------------------------------------------
say()  { printf '%s\n' "$*"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!  %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mx  %s\033[0m\n' "$*" >&2; exit 1; }

open_url() {
  # Every desktop OS spells this differently and none of them fail loudly, so try in order
  # and simply print the address if nothing works — a URL the operator can click is the
  # actual goal, opening it automatically is a nicety.
  if command -v open        >/dev/null 2>&1; then open "$1"        >/dev/null 2>&1 && return 0; fi
  if command -v xdg-open    >/dev/null 2>&1; then xdg-open "$1"    >/dev/null 2>&1 && return 0; fi
  if command -v gnome-open  >/dev/null 2>&1; then gnome-open "$1"  >/dev/null 2>&1 && return 0; fi
  return 1
}

cd "$(dirname "$0")"

MODE=start
case "${1:-}" in
  --update) MODE=update ;;
  --stop)   MODE=stop ;;
  --help|-h)
    say "usage: ./setup.sh [--update | --stop]"
    exit 0 ;;
  "") ;;
  *) die "unknown option: $1 (try --help)" ;;
esac

# ---------------------------------------------------------------------------------------
step "Checking Docker"

if ! command -v docker >/dev/null 2>&1; then
  warn "Docker is not installed."
  say ""
  say "Docker is the only thing you need to install by hand. Get it here:"
  say "  https://docs.docker.com/get-started/get-docker/"
  say ""
  say "Then run this script again."
  open_url "https://docs.docker.com/get-started/get-docker/" || true
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  die "Docker is installed but not running. Start Docker Desktop (or the docker service) and try again."
fi

# Compose ships two ways: the v2 plugin (`docker compose`) and the older standalone binary
# (`docker-compose`). Both are still in the wild, so detect rather than assume.
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
  warn "Using the older docker-compose. It works, but upgrading Docker is worth doing."
else
  die "Docker Compose is missing. Update Docker Desktop, or install the compose plugin."
fi
say "Docker is ready ($DC)."

# ---------------------------------------------------------------------------------------
if [ "$MODE" = stop ]; then
  step "Stopping"
  $DC down
  say "Stopped. Your data in ./data is untouched; run ./setup.sh to start again."
  exit 0
fi

# ---------------------------------------------------------------------------------------
step "Checking ports"

port_busy() {
  # Try the tools most likely to exist, in order. If none do, skip the check rather than
  # guessing: a false "port in use" that blocks startup is worse than no check at all.
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1 && return 0
    return 1
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -q ":$1 " && return 0
    return 1
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -an 2>/dev/null | grep -q "[:.]$1 .*LISTEN" && return 0
    return 1
  fi
  return 1
}

BUSY=''
for p in 80 443; do
  if port_busy "$p"; then BUSY="$BUSY $p"; fi
done
if [ -n "$BUSY" ]; then
  warn "Something is already listening on:$BUSY"
  say ""
  say "That is usually another web server (Apache, nginx, another Caddy) or a previous copy"
  say "of this stack. Stop it, or edit docker-compose.yml to use different ports."
  say ""
  printf 'Try to start anyway? [y/N] '
  read -r answer
  case "$answer" in [yY]*) ;; *) exit 1 ;; esac
fi

# ---------------------------------------------------------------------------------------
step "Preparing folders"

mkdir -p data gamedata client
if [ ! -f .env ]; then
  cat > .env <<'ENVEOF'
# Settings the containers read at startup. Safe to edit; re-run ./setup.sh afterwards.

# A domain pointed at this machine, or "localhost" if you do not have one. With a real
# domain you get a real HTTPS certificate automatically; localhost gets a self-signed one.
SERVER_DOMAIN=localhost
# Leave as-is for localhost; blank this line out once you set a real domain above.
TLS_MODE=tls internal

# Object storage for player uploads, only if you choose S3 in the setup wizard.
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
ENVEOF
  say "Created .env with default settings."
fi

if [ -z "$(ls -A gamedata 2>/dev/null)" ]; then
  warn "./gamedata is empty."
  say "   Copy your Morrowind files there (Morrowind.esm and Morrowind.bsa at minimum)."
  say "   You can do that later — the server will start and tell you what is missing."
fi

# ---------------------------------------------------------------------------------------
if [ "$MODE" = update ]; then
  step "Updating"
  $DC pull || warn "Could not pull newer images; rebuilding from source instead."
  $DC build --pull
else
  step "Building"
  $DC build
fi

step "Starting"
$DC up -d

# ---------------------------------------------------------------------------------------
step "Waiting for the server"

# Poll the container's own healthcheck rather than sleeping a fixed amount: a first build on
# a slow box takes a while, and a fixed wait is either wrong or wasteful.
i=0
STATUS=starting
# WAIT FOR THE DASHBOARD, NOT FOR "healthy".
#
# A server with no Morrowind files yet answers /healthz with 503 on purpose — it is running,
# it just cannot host players, and telling a monitor otherwise would be a lie. That is also
# the NORMAL state of a first run, which this script's own message two steps up promises is
# fine. Waiting for the container to report `healthy` therefore waits for something that
# will never happen on the very run this script exists to support: 90 seconds of dots and
# then a failure, with the browser never opening.
#
# So poll the thing we are about to open. If /admin answers, the operator has somewhere to
# go, and whether the world is playable yet is a question the dashboard itself answers far
# better than an exit code can.
READY=no
CONFIGURED=no
while [ "$i" -lt 90 ]; do
  RUNNING=$(docker inspect -f '{{.State.Running}}' openmw-web 2>/dev/null || echo missing)
  if [ "$RUNNING" != true ]; then
    warn "The server stopped. Its last words:"
    $DC logs --tail 30 openmw-web
    die "Server did not stay up. The log above says why."
  fi
  # -k because a self-signed certificate is the default here; this is a loopback request to
  # a server we just started, not a trust decision.
  if curl -skf -o /dev/null --max-time 3 "https://localhost/admin" 2>/dev/null; then
    READY=yes
    STATUS=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
      openmw-web 2>/dev/null || echo none)
    [ "$STATUS" = healthy ] && CONFIGURED=yes
    break
  fi
  i=$((i + 1))
  printf '.'
  sleep 1
done
printf '\n'

if [ "$READY" != yes ]; then
  warn "The dashboard did not come up. Recent log:"
  $DC logs --tail 20 openmw-web
  say ""
  say "The containers are running, so this may just be slow. Try https://localhost/admin"
  say "in a moment, or run:  $DC logs -f openmw-web"
  exit 1
fi

# ---------------------------------------------------------------------------------------
DOMAIN=$(grep -E '^SERVER_DOMAIN=' .env 2>/dev/null | cut -d= -f2- || true)
if [ -n "$DOMAIN" ] && [ "$DOMAIN" != localhost ]; then URL="https://$DOMAIN/admin"; else DOMAIN=""; URL="https://localhost/admin"; fi

step "Ready"
say ""
say "  Admin dashboard:  $URL"
say ""
if [ "$CONFIGURED" != yes ]; then
  say "  The server is up but has no Morrowind files yet, so players cannot join. That is"
  say "  expected on a first run — the dashboard walks you through adding them."
  say ""
fi
if [ -z "$DOMAIN" ]; then
  say "  Your browser will warn that the connection is not private. That is expected —"
  say "  the certificate is one this server signed itself, because no domain is configured."
  say "  Click Advanced, then Proceed. Set SERVER_DOMAIN in .env to remove the warning."
  say ""
fi
say "  The first thing it asks for is an administrator account. After that a short wizard"
say "  sets the server up. Nothing else needs a terminal."
say ""
say "  Logs:    $DC logs -f openmw-web"
say "  Stop:    ./setup.sh --stop"
say "  Update:  ./setup.sh --update"
say ""

open_url "$URL" || say "  Open that address in your browser."
