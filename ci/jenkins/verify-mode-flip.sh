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
# So this drives the real thing: a real image, a real restart policy, a real signal. It asserts
# BOTH directions, because the way back is the half that used to be missing, and that the same
# account signs in on either program (one shared account store) and the settings tree survives.
#
# Usage: ci/jenkins/verify-mode-flip.sh [image] [port]
#   image  defaults to omw-flip:test — build it with: docker build -t omw-flip:test server
# Local/CI only: it creates and destroys its own container and volume, and needs a free port.
set -uo pipefail

IMAGE="${1:-omw-flip:test}"
PORT="${2:-18099}"
NAME=omw-mode-flip-test
VOL=omw-mode-flip-test-data
BASE="http://127.0.0.1:$PORT"
OWNER='{"name":"owner@example.com","password":"a-long-enough-passphrase"}'
export MSYS_NO_PATHCONV=1 # git-bash mangles the container paths below without it

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
  local deadline=$((SECONDS + 120))
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

docker image inspect "$IMAGE" >/dev/null 2>&1 \
  || { echo "FATAL: $IMAGE not built. Run: docker build -t $IMAGE server"; exit 2; }
cleanup

say "a fresh data dir starts the single-player server"
docker run -d --name "$NAME" --restart unless-stopped -p "$PORT:8080" -v "$VOL:/data" "$IMAGE" >/dev/null \
  || fail "could not start the container"
wait_up || fail "the dashboard never answered"
[ "$(marker)" = "(none)" ] || fail "a fresh data dir must carry no marker, got '$(marker)'"
state | grep -q '"platform":false' || fail "a fresh container must be a game, not the platform"
ok "no marker, one game, /admin answers"

say "finishing the wizard as MULTIPLAYER writes the marker"
TOKEN=$(post /admin/api/setup/owner '' "$OWNER" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || fail "could not claim the first owner account"
post /admin/api/setup "$TOKEN" '{"deploymentMode":"multiplayer","completed":true}' | grep -q '"ok":true' \
  || fail "the wizard refused a multiplayer answer (is the experimental gate back?)"
[ "$(marker)" = "gateway" ] || fail "expected marker 'gateway', got '$(marker)'"
ok "marker is 'gateway'"

say "the dashboard's restart brings the container back as the MULTIPLAYER server"
post /admin/api/restart "$TOKEN" | grep -q '"ok":true' || fail "the restart route refused"
sleep 12 # SIGTERM, drain, exit, restart policy
wait_up || fail "the multiplayer server never served /admin — this is the old lockout"
docker logs "$NAME" 2>&1 | grep -q '"event":"entrypoint.mode","mode":"gateway"' \
  || fail "the entrypoint did not read the marker"
docker logs "$NAME" 2>&1 | grep -q '"event":"gateway.start"' || fail "the multiplayer server did not start"
state | grep -q '"platform":true' || fail "/admin answered, but not as the platform"
[ "$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "$BASE/admin")" = 200 ] || fail "the /admin page did not load"
ok "multiplayer server up, its dashboard serving"

say "the same account signs in on the other program (one shared store)"
TOKEN2=$(post /admin/api/login '' "$OWNER" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN2" ] || fail "the owner could not sign in on the multiplayer server"
ok "signed in"

say "and the way BACK is a button, not a shell"
post /admin/api/setup "$TOKEN2" '{"deploymentMode":"single","completed":true}' | grep -q '"ok":true' \
  || fail "the wizard refused a single-player answer"
[ "$(marker)" = "single" ] || fail "expected marker 'single', got '$(marker)'"
post /admin/api/restart "$TOKEN2" | grep -q '"ok":true' || fail "the restart route refused"
sleep 12
wait_up || fail "the game server never came back"
docker logs "$NAME" 2>&1 | grep -q '"event":"server.start"' || fail "the world server did not start"
state | grep -q '"platform":false' || fail "it did not come back as a game"
ok "back to single player, dashboard still there"

say "the settings tree survived both switches"
docker exec "$NAME" sh -c 'test -s /data/config.dashboard.toml' || fail "config.dashboard.toml is missing or empty"
docker exec "$NAME" sh -c 'grep -q deploymentMode /data/config.dashboard.toml' \
  || fail "the wizard's answers are not in the settings tree"
ok "config.dashboard.toml intact"

cleanup
printf '\n\033[32mMODE FLIP OK\033[0m — the wizard starts the server it names, in both directions.\n'
