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
LOG="${LOG:-$OUT/jenkins-${BUILD_NUMBER:-local}.log}"

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
# That uid cannot write the root-owned resources tree, so mp-harness.mjs's syncPeerScripts
# cannot copy the repo's mp scripts into the peer: mount them over the image path instead
# (the peer then runs the checkout's Lua, and syncPeerScripts verifies by hash that it does —
# a mismatch fails the run, backlog 184).
# The harness itself exits 1 on any FAIL, which fails the stage.
# HARNESS_DOCKER_ARGS: extra `docker run` flags for a wrapper that needs more environment in
# the container (run-fresh-install.sh points the play server at its own gateway).
PEER_RES=/usr/local/share/openmw/resources/vfs
set +e
# shellcheck disable=SC2086
# --init: a real PID 1 that REAPS. Without it every Chrome and sim peer the harness kills
# becomes a zombie under the container's `sh`, and a full sweep ended with 2422 of them and a
# load average of 39 on a 32-core box (#107) -- every timing assertion in the back half of the
# run failed for reasons that had nothing to do with the code under test.
docker run --rm --init --entrypoint sh --user "$(id -u):$(id -g)" -e HOME=/tmp   -e OMW_SIM_PEER_BIN=/usr/local/bin/openmw ${HARNESS_DOCKER_ARGS:-}   -v "$HOST_SRC:/repo"   -v "$HOST_SRC/openmw/files/data/scripts/mp:$PEER_RES/scripts/mp:ro"   -v "$HOST_SRC/openmw/files/data/mp.omwscripts:$PEER_RES/mp.omwscripts:ro"   openmw-harness-peer:local   -c '[ -x server/node_modules/.bin/tsc ] || (cd server && npm ci); exec node wasm-build/mp-harness.mjs "$@"' \
  -- ${SCENARIOS:-} 2>&1 | tee "$LOG"
rc=${PIPESTATUS[0]}
set -e
# Verdict lines print twice in the raw log (see harness-log-and-build-context); dedupe here.
echo "==> verdicts:"; grep -E '^(PASS|FAIL|SKIP) s' "$LOG" | sort -u || true
exit "$rc"
