#!/usr/bin/env bash
# Run the multiplayer browser harness on the build server against the images THIS build made.
# Dev/test only: it never touches prod (prod is GitHub Actions -> OVH, on push to main).
#
# What it does, in order:
#   1. copies the engine artifacts out of the engine image into play/ -- client Lua is baked
#      into openmw.data, so the harness serves the engine as BUILT, not the tree;
#   2. rebuilds the harness image (sim peer + Chrome) on top of the peer image just built.
#      --no-cache on purpose: BuildKit has reused a stale base after a retag;
#   3. runs the scenarios ($SCENARIOS, empty = the whole suite) with the peer binary managed
#      by the server, exactly as the laptop and the OVH release box run them.
#
# Like restage-inputs.sh this runs INSIDE the Jenkins container, and -v paths are resolved by
# the HOST daemon, so the harness container mounts $HOST_SRC (the host's view of /src).
set -euo pipefail

SRC="${SRC:-/src}"
HOST_SRC="${HOST_SRC:-/home/jenkins/morrowind-src}"
ENGINE="${ENGINE_TAG:-morrowind:test}"
PEER="${PEER_TAG:-openmw-mp:tier2}"
OUT="wasm-build/harness-out"
LOG="$OUT/jenkins-${BUILD_NUMBER:-local}.log"

cd "$SRC"
[ -d play/mwdata ] || { echo "FATAL: play/mwdata (game data for the peer) is missing on the builder"; exit 1; }

echo "==> engine artifacts from $ENGINE -> play/"
hash=$(docker run --rm --entrypoint sh "$ENGINE" -c 'ls /srv/e | head -1')
[ -n "$hash" ] || { echo "FATAL: no /srv/e/<hash> in $ENGINE"; exit 1; }
cid=$(docker create "$ENGINE")
for f in openmw.wasm openmw.data openmw.js openmw.wasm.br openmw.data.br openmw.js.br; do
  docker cp "$cid:/srv/e/$hash/$f" "play/$f.new" && mv "play/$f.new" "play/$f"
done
docker rm "$cid" >/dev/null
ls -la play/openmw.wasm play/openmw.data

echo "==> harness image on top of $PEER"
docker tag "$PEER" openmw-simpeer:local
docker build --no-cache -t openmw-harness-peer:local -f wasm-build/Dockerfile.harness-peer . >/dev/null

mkdir -p "$OUT"
echo "==> scenarios: ${SCENARIOS:-<full suite>} (log: $LOG)"
# --user: files the run writes into /repo must stay owned by jenkins or the next checkout fails.
# The harness itself exits 1 on any FAIL, which fails the stage.
set +e
# shellcheck disable=SC2086
docker run --rm --entrypoint sh --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e OMW_SIM_PEER_BIN=/usr/local/bin/openmw \
  -v "$HOST_SRC:/repo" openmw-harness-peer:local \
  -c '[ -x server/node_modules/.bin/tsc ] || (cd server && npm ci); exec node wasm-build/mp-harness.mjs "$@"' \
  -- ${SCENARIOS:-} 2>&1 | tee "$LOG"
rc=${PIPESTATUS[0]}
set -e
# Verdict lines print twice in the raw log (see harness-log-and-build-context); dedupe here.
echo "==> verdicts:"; grep -E '^(PASS|FAIL|SKIP) s' "$LOG" | sort -u || true
exit "$rc"
