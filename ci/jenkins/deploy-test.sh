#!/usr/bin/env bash
# Ship a locally-built image to the test app server and restart it there.
#
# Usage: deploy-test.sh engine|server
#
# No registry: `docker save | ssh docker load` over the LAN is fast enough and is one less
# moving part. If deploys get slow enough to annoy, stand up a registry on the build server.
set -euo pipefail

WHAT="${1:?usage: deploy-test.sh engine|server}"

# Deployment values come from ci/jenkins/config.env (gitignored — this repo is public).
# Environment wins, so a CI job can override without touching the file.
_cfg="$(dirname "$0")/config.env"
# shellcheck disable=SC1090
[ -f "$_cfg" ] && . "$_cfg"
TEST_HOST="${TEST_HOST:?set TEST_HOST in ci/jenkins/config.env (see config.env.example)}"
SSH_KEY="${SSH_KEY:?set SSH_KEY in ci/jenkins/config.env (see config.env.example)}"
SSH="ssh -i $SSH_KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

# Both containers share a user-defined network so Caddy can reach the gateway by container
# name. The default bridge has no DNS, so this is not optional once the engine proxies /ws.
NETWORK="${NETWORK:-omw-test}"

case "$WHAT" in
  engine)
    TAG="${TAG:-morrowind:test}"; NAME=morrowind-test; PORT=8080
    # The engine image is self-contained: caddy + deploy/Caddyfile, which already sets the
    # COOP/COEP/CORP headers the engine needs. No extra proxy required to smoke-test it.
    #
    # mwdata is NOT in the image (.dockerignore excludes it - it is shipped/mounted separately).
    # index.html fetches /mwdata/{Morrowind,Tribunal,Bloodmoon}.esm, so without this mount you get
    # a working launcher that can only run the ?nomw demo. Staged once on the test server; the
    # .br siblings must be alongside the raw files for brotli negotiation.
    #
    # /srv/data carries the optional streamed performance pack (openmw-web-assets.bsa, the
    # MOP + Project Atlas build). mountAssetPack() probes moddata/ then data/ and continues
    # without it if neither answers, so this mount is what turns it on for the test site.
    #
    # MP_UPSTREAM points the Caddyfile's /ws + /auth proxy at the gateway container, which is
    # named per-environment (openmw-mp in production, openmw-mp-test here).
    RUN_ARGS="-p ${PORT}:8080 -v /opt/morrowind-test/mwdata:/srv/mwdata:ro \
      -v /opt/morrowind-test/data:/srv/data:ro -e MP_UPSTREAM=openmw-mp-test:8080"
    HEALTH_PATH="/"
    ;;
  server)
    TAG="${TAG:-openmw-mp:tier2}"; NAME=openmw-mp-test; PORT=
    # ONE public port. The gateway (dist/gateway.mjs) fronts the world directory, SSO and the
    # locker; per-world server processes get internal ports from --base-port 9000 and are never
    # published. /data/gamedata must hold real game data or the sim peer will not start.
    # S3/locker credentials come from the environment, never from a config file (see the
    # [locker] comment in config.default.toml). Staged once at /opt/openmw-mp-test/data/s3.env,
    # mode 600, outside the repo. The locker stays disabled until [locker].endpoint and
    # .bucket are also set in config.toml - creds alone are not enough.
    #
    # NO published host port. The gateway is reached only through the engine container's Caddy
    # on :8080, same origin as the game — a second public port is a second address to get
    # wrong, and the client never had a way to use it.
    RUN_ARGS="-v /opt/openmw-mp-test/data:/data --env-file /opt/openmw-mp-test/data/s3.env"
    HEALTH_PATH="/healthz"
    ;;
  *) echo "unknown target: $WHAT (expected engine|server)"; exit 2 ;;
esac

echo "==> shipping $TAG to $TEST_HOST"
docker save "$TAG" | $SSH "$TEST_HOST" 'docker load'

echo "==> (re)starting $NAME"
$SSH "$TEST_HOST" "
  set -e
  sudo mkdir -p /opt/openmw-mp-test/data /opt/morrowind-test/data 2>/dev/null || true
  docker network create $NETWORK >/dev/null 2>&1 || true
  docker rm -f $NAME >/dev/null 2>&1 || true
  # Run as whoever owns the staged data dir. config.toml and s3.env are mode 600, so a
  # container whose user does not match cannot read them and dies at loadConfig(). The
  # image's own user is NOT a safe assumption: the legacy alpine image ran as uid 1000 and
  # happened to match, while the real (debian) image runs as uid 1001 and does not. Deriving
  # it means restaging the data under a different owner cannot silently break the deploy.
  USER_FLAG=''
  if [ '$WHAT' = 'server' ]; then USER_FLAG=\"--user \$(stat -c '%u:%g' /opt/openmw-mp-test/data)\"; fi
  docker run -d --name $NAME --restart unless-stopped --network $NETWORK \$USER_FLAG $RUN_ARGS $TAG >/dev/null
"

echo "==> health check"
HEALTHY=0
for i in $(seq 1 30); do
  # The gateway has no published port now, so probe it from inside the network rather than
  # from the host. The engine still answers on its published port.
  if [ -n "$PORT" ]; then
    code=$($SSH "$TEST_HOST" "curl -s -o /dev/null -w '%{http_code}' http://localhost:${PORT}${HEALTH_PATH}" || echo 000)
  else
    code=$($SSH "$TEST_HOST" "docker run --rm --network $NETWORK curlimages/curl:latest -s -o /dev/null -w '%{http_code}' http://${NAME}:8080${HEALTH_PATH}" || echo 000)
  fi
  if [ "$code" = "200" ]; then
    echo "    $NAME healthy (HTTP $code)${PORT:+ on port $PORT}"
    HEALTHY=1
    break
  fi
  sleep 2
done

if [ "$HEALTHY" = "1" ]; then
  if [ "$WHAT" = "server" ]; then
    # Server-authoritative NPCs are the deployment, not an optional mode, so assert on the
    # logs rather than trusting a 200 from /healthz — the gateway answers /healthz happily
    # while the per-world process crash-loops underneath it.
    #
    # Gate on simpeer.ready_to_spawn: it is emitted only after the peer BINARY resolved and
    # the game data parsed, which is exactly the pair that silently degraded before. Do not
    # gate on '"enabled":true' — that was an older log shape that no longer exists, and
    # matching it fails every deploy including correct ones.
    PEER=$($SSH "$TEST_HOST" "docker logs $NAME 2>&1 | grep -m1 'simpeer.ready_to_spawn'" || true)
    # '|| true' must live INSIDE the remote command: grep -c prints "0" and still exits 1 on
    # no match, so an outer '|| echo 0' would emit "0\n0" and break the integer test below.
    CRASH=$($SSH "$TEST_HOST" "docker logs $NAME 2>&1 | grep -c 'world.crashed' || true")
    echo "    ${PEER:-<no simpeer.ready_to_spawn line>}"
    case "$PEER" in
      *'"binary"'*) echo "    sim peer active - server-authoritative NPCs" ;;
      *) echo "FAILED: sim peer did not start. Check the image was built from"
         echo "        server/Dockerfile.simpeer (the alpine server/Dockerfile has NO peer"
         echo "        binary), and that /data/gamedata contains Morrowind.esm."
         exit 1 ;;
    esac
    # A crash-looping world process still leaves the gateway healthy, so catch it explicitly.
    if [ "${CRASH:-0}" -gt 0 ]; then
      echo "    NOTE: $CRASH world.crashed event(s) in the log — check [server].password is set."
    fi
  fi

  # The serving CONTRACT, not just liveness. A container answering 200 tells you nothing about
  # whether a player can sign in and reach a world: every check in smoke-test.sh is a bug that
  # shipped green. Run it against the public origin, because half the contract (TLS, the edge
  # forwarding X-Forwarded-Proto, the launcher gate) only exists out there.
  SMOKE_URL="${SMOKE_URL-}"   # empty = skip the gate; see config.env.example
  if [ -n "$SMOKE_URL" ]; then
    echo "==> contract check against $SMOKE_URL"
    if ! "$(dirname "$0")/smoke-test.sh" "$SMOKE_URL"; then
      echo "FAILED: the deploy is live but does not satisfy the serving contract."
      exit 1
    fi
  fi
  exit 0
fi

echo "FAILED: $NAME did not become healthy"
$SSH "$TEST_HOST" "docker logs --tail 40 $NAME" || true
exit 1

