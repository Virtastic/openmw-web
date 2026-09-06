#!/usr/bin/env bash
# THE SETUP WIZARD'S ANSWER MUST START THE SERVER IT NAMES — proven on a real container, not
# argued from the source.
#
# The wizard writes <data>/.mode ('single' or 'gateway') and asks for a restart; the process
# exits on SIGTERM, the container's restart policy brings it back, and docker-entrypoint.sh
# re-reads the marker and execs the other program. Three separate mechanisms, none of which a
# unit test can see end to end, and the failure mode is the worst one there is: choosing
# multiplayer leaves the operator on a server that is not multiplayer, or — before both halves
# landed — on one with no dashboard at all, reachable only by editing a file over a shell.
#
# TWO IMAGES SHIP, and they differ only in what they do when NOBODY has chosen yet:
#
#   server/Dockerfile           self-hosted; OMW_DEFAULT_MODE unset -> 'single' (one person,
#                               one game, the common case)
#   server/Dockerfile.simpeer   the hosted platform; OMW_DEFAULT_MODE=gateway, because that is
#                               what production has always run and a deploy must not move a
#                               live platform onto a different program on its own
#
# The MARKER outranks both, which is the whole point — so this script takes the image's
# default and drives the round trip from wherever that starts, in both directions.
#
# Usage: ci/jenkins/verify-mode-flip.sh [image] [port] [default-mode]
#   ci/jenkins/verify-mode-flip.sh omw-flip:test 18099 single      # docker build -t omw-flip:test server
#   ci/jenkins/verify-mode-flip.sh openmw-mp:tier2 18099 gateway     # ci/jenkins/build-server.sh
# Local/CI only: it creates and destroys its own container and volume, and needs a free port.
set -uo pipefail

IMAGE="${1:-omw-flip:test}"
PORT="${2:-18099}"
DEFAULT_MODE="${3:-single}"
NAME=omw-mode-flip-test
VOL=omw-mode-flip-test-data
BASE="http://127.0.0.1:$PORT"
OWNER='{"name":"owner@example.com","password":"a-long-enough-passphrase"}'
export MSYS_NO_PATHCONV=1 # git-bash mangles the container paths below without it

# The marker word, the wizard's answer, and what /admin/api/state reports, for each mode.
if [ "$DEFAULT_MODE" = gateway ]; then
  OTHER_MODE=single;  DEFAULT_ANSWER=multiplayer; OTHER_ANSWER=single
  DEFAULT_PLATFORM=true; OTHER_PLATFORM=false
  DEFAULT_START='"event":"gateway.start"'; OTHER_START='"event":"server.start"'
else
  OTHER_MODE=gateway; DEFAULT_ANSWER=single;      OTHER_ANSWER=multiplayer
  DEFAULT_PLATFORM=false; OTHER_PLATFORM=true
  DEFAULT_START='"event":"server.start"'; OTHER_START='"event":"gateway.start"'
fi

say()  { printf '== %s\n' "$1"; }
ok()   { printf '   \033[32mok\033[0m   %s\n' "$1"; }
fail() {
  printf '   \033[31mFAIL\033[0m %s\n' "$1"
  echo '--- last 30 lines of container log ---'
  docker logs --tail 30 "$NAME" 2>&1 | tail -30
  cleanup
  exit 1
}
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1; docker volume rm "$VOL" >/dev/null 2>&1; }

state()  { curl -s --max-time 5 "$BASE/admin/api/state"; }
marker() { docker exec "$NAME" sh -c 'cat /data/.mode 2>/dev/null || echo "(none)"' | tr -d '\r\n'; }
# The dashboard, not /healthz: a server configured for multiplayer with no game data reports
# itself unhealthy on purpose, and that is not what this test is asking about.
wait_up() {
  local deadline=$((SECONDS + 150))
  while [ $SECONDS -lt $deadline ]; do
    state | grep -q '"authed"' && return 0
    sleep 2
  done
  return 1
}
post() { # post <path> [token] [json]
  curl -s --max-time 15 -X POST \
    ${2:+-H "authorization: Bearer $2"} \
    ${3:+-H 'content-type: application/json'} ${3:+-d "$3"} \
    "$BASE$1"
}
# The wizard's answer, then the restart it asks for. Leaves the container back up.
flip_to() { # flip_to <token> <answer> <expected-marker>
  post /admin/api/setup "$1" "{\"deploymentMode\":\"$2\",\"completed\":true}" | grep -q '"ok":true' \
    || fail "the wizard refused a '$2' answer (is a feature gate back?)"
  [ "$(marker)" = "$3" ] || fail "expected marker '$3', got '$(marker)'"
  post /admin/api/restart "$1" | grep -q '"ok":true' || fail "the restart route refused"
  sleep 12 # SIGTERM, drain, exit, restart policy
  wait_up || fail "nothing served /admin after restarting into '$3' — this is the old lockout"
}

docker image inspect "$IMAGE" >/dev/null 2>&1 \
  || { echo "FATAL: $IMAGE not built. See the usage note at the top of this script."; exit 2; }
cleanup

say "a fresh data dir starts this image's default ($DEFAULT_MODE)"
docker run -d --name "$NAME" --restart unless-stopped -p "$PORT:8080" -v "$VOL:/data" "$IMAGE" >/dev/null \
  || fail "could not start the container"
wait_up || fail "the dashboard never answered"
[ "$(marker)" = "(none)" ] || fail "a fresh data dir must carry no marker, got '$(marker)'"
docker logs "$NAME" 2>&1 | grep -q "$DEFAULT_START" || fail "the default program did not start"
state | grep -q "\"platform\":$DEFAULT_PLATFORM" || fail "/admin answered, but not as $DEFAULT_MODE"
ok "no marker, $DEFAULT_MODE, /admin answers"

say "the wizard's other answer ($OTHER_ANSWER) writes the marker and the restart obeys it"
TOKEN=$(post /admin/api/setup/owner '' "$OWNER" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || fail "could not claim the first owner account"
flip_to "$TOKEN" "$OTHER_ANSWER" "$OTHER_MODE"
docker logs "$NAME" 2>&1 | grep -q "\"event\":\"entrypoint.mode\",\"mode\":\"$OTHER_MODE\"" \
  || fail "the entrypoint did not read the marker"
docker logs "$NAME" 2>&1 | grep -q "$OTHER_START" || fail "the other program did not start"
state | grep -q "\"platform\":$OTHER_PLATFORM" || fail "it did not come back as $OTHER_MODE"
[ "$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "$BASE/admin")" = 200 ] || fail "the /admin page did not load"
ok "switched to $OTHER_MODE, and its dashboard serves"

say "the same account signs in on the other program (one shared store)"
TOKEN2=$(post /admin/api/login '' "$OWNER" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN2" ] || fail "the owner could not sign in after the switch"
ok "signed in"

say "and the way BACK is a button, not a shell"
flip_to "$TOKEN2" "$DEFAULT_ANSWER" "$DEFAULT_MODE"
docker logs "$NAME" 2>&1 | grep -q "$DEFAULT_START" || fail "the original program did not start again"
state | grep -q "\"platform\":$DEFAULT_PLATFORM" || fail "it did not come back as $DEFAULT_MODE"
ok "back to $DEFAULT_MODE, dashboard still there"

say "the settings tree survived both switches"
docker exec "$NAME" sh -c 'test -s /data/config.dashboard.toml' || fail "config.dashboard.toml is missing or empty"
docker exec "$NAME" sh -c 'grep -q deploymentMode /data/config.dashboard.toml' \
  || fail "the wizard's answers are not in the settings tree"
ok "config.dashboard.toml intact"

cleanup
printf '\n\033[32mMODE FLIP OK\033[0m (%s, default %s) — the wizard starts the server it names, both ways.\n' \
  "$IMAGE" "$DEFAULT_MODE"
