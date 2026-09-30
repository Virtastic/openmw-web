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
# THE BOX'S GPU, when it has one (the builder LXC carries a Tesla M40 since 2026-09-24). Without
# it every client rendered on SwiftShader at a frame every ~2 s, and scenarios failed on the
# box's pace rather than the game's (#152: s59, s175's weather, s10). The container gets the
# device through the nvidia runtime, but not NVIDIA's EGL vendor file -- ci/jenkins/nvidia
# supplies it, or glvnd picks Mesa's llvmpipe. HARNESS_GPU=0 forces software GL.
GPU_ARGS=""
if [ "${HARNESS_GPU:-1}" != "0" ] && docker info 2>/dev/null | grep -q 'Runtimes:.*nvidia'; then
  GPU_ARGS="--gpus all -e NVIDIA_DRIVER_CAPABILITIES=all -v $HOST_SRC/ci/jenkins/nvidia:/nvjson:ro -e __EGL_VENDOR_LIBRARY_FILENAMES=/nvjson/10_nvidia.json -e SMOKE_GL=angle-gpu"
  echo "==> GPU: the harness renders on the box's NVIDIA GPU (HARNESS_GPU=0 to turn off)"
fi
# PARALLEL LANES (HARNESS_LANES, default 1). Each lane is its own container -- its own network
# namespace, play server, game servers and ports -- running every Nth scenario of the list.
# DEFAULT 1 ON THE BUILDER: the M40 only draws; the engine, the sim peer and the browsers
# simulate on the CPU, and two lanes drove a 16-core box to a load of 57 (#157) -- the slow-box
# timing failures all over again (s131 missed a death). A box with the cores takes 2+.
HARNESS_LANES="${HARNESS_LANES:-1}"
# The list, expanded here so it can be dealt out: the named prefixes, or the whole suite minus
# the standalone scenarios (s170 runs through run-fresh-install.sh), as mp-harness.mjs does.
ALL=()
if [ -n "${SCENARIOS:-}" ]; then
  for w in $SCENARIOS; do
    for f in wasm-build/mp-scenarios/"$w"*.mjs; do
      [ -e "$f" ] || continue
      # A standalone scenario (s170) runs through run-fresh-install.sh, which sets HARNESS_STANDALONE. Named in
      # a targeted run beside others it is left out HERE, or it SKIPs, the stage exits 1 and the rehearsal
      # stage never runs (#189).
      if [ -z "${HARNESS_STANDALONE:-}" ] && grep -q 'export const standalone = true' "$f"; then continue; fi
      ALL+=("$(basename "$f" .mjs)")
    done
  done
else
  for f in wasm-build/mp-scenarios/s*.mjs; do
    grep -q 'export const standalone = true' "$f" || ALL+=("$(basename "$f" .mjs)")
  done
fi
mapfile -t ALL < <(printf '%s\n' "${ALL[@]}" | awk 'NF && !seen[$0]++')
[ "${#ALL[@]}" -gt 0 ] || { echo "FATAL: no scenarios matched: ${SCENARIOS:-<full suite>}"; exit 2; }
[ "${#ALL[@]}" -lt "$HARNESS_LANES" ] && HARNESS_LANES=${#ALL[@]}

run_lane() { # the scenario names; output on stdout
  # shellcheck disable=SC2086
  # --init: a real PID 1 that REAPS. Without it every Chrome and sim peer the harness kills
  # becomes a zombie under the container's `sh`, and a full sweep ended with 2422 of them and a
  # load average of 39 on a 32-core box (#107) -- every timing assertion in the back half of the
  # run failed for reasons that had nothing to do with the code under test.
  docker run --rm --init --entrypoint sh --user "$(id -u):$(id -g)" -e HOME=/tmp   -e OMW_SIM_PEER_BIN=/usr/local/bin/openmw ${GPU_ARGS} ${HARNESS_DOCKER_ARGS:-}   -v "$HOST_SRC:/repo"   -v "$HOST_SRC/openmw/files/data/scripts/mp:$PEER_RES/scripts/mp:ro"   -v "$HOST_SRC/openmw/files/data/mp.omwscripts:$PEER_RES/mp.omwscripts:ro"   openmw-harness-peer:local   -c '[ -x server/node_modules/.bin/tsc ] || (cd server && npm ci); exec node wasm-build/mp-harness.mjs "$@"' \
    -- "$@" 2>&1
}

set +e
if [ "$HARNESS_LANES" -le 1 ]; then
  run_lane "${ALL[@]}" | tee "$LOG"
  rc=${PIPESTATUS[0]}
else
  # BUILD THE SERVER ONCE, before the lanes: mp-harness.mjs rebuilds server/dist when it is
  # stale, and two lanes compiling the one shared checkout at once would race on the files.
  docker run --rm --entrypoint sh --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$HOST_SRC:/repo" openmw-harness-peer:local \
    -c 'cd server && { [ -x node_modules/.bin/tsc ] || npm ci; } && npm run build' > "$OUT/build-${BUILD_NUMBER:-local}.log" 2>&1 \
    || { echo "FATAL: the server build failed"; cat "$OUT/build-${BUILD_NUMBER:-local}.log"; exit 1; }
  echo "==> ${#ALL[@]} scenarios over $HARNESS_LANES lanes"
  pids=(); logs=()
  for ((k = 0; k < HARNESS_LANES; k++)); do
    lane=(); for ((i = k; i < ${#ALL[@]}; i += HARNESS_LANES)); do lane+=("${ALL[$i]}"); done
    lane_log="${LOG%.log}-lane$((k + 1)).log"
    logs+=("$lane_log")
    : > "$lane_log"
    echo "==> lane $((k + 1)): ${#lane[@]} scenarios (log: $lane_log)"
    run_lane "${lane[@]}" > "$lane_log" 2>&1 &
    pids+=($!)
  done
  # Live progress in the stage log: every lane's lines as they come (verdicts, failures).
  # --pid=$$: the tail ends with this script (a kill would reach only the grep after it).
  tail -n +1 -F --pid=$$ "${logs[@]}" 2>/dev/null | grep --line-buffered -vE '^==> .* <==$' &
  rc=0
  for pid in "${pids[@]}"; do wait "$pid" || rc=1; done
  sleep 2 # the last lines reach the stage log
  cat "${logs[@]}" > "$LOG"
fi
set -e
# Verdict lines print twice in the raw log (see harness-log-and-build-context); dedupe here.
echo "==> verdicts:"; grep -E '^(PASS|FAIL|SKIP) s' "$LOG" | sort -u || true
pass=$(grep -E '^PASS s' "$LOG" | sort -u | wc -l || true); fail=$(grep -E '^FAIL s' "$LOG" | sort -u | wc -l || true)
echo "==> ${pass} passed, ${fail} failed over ${HARNESS_LANES} lane(s)"
flaky=$(grep -E '^FLAKY  s' "$LOG" | sort -u || true); [ -n "$flaky" ] && { echo "==> FLAKY (failed once, passed on the immediate retry; counted green, each one a lead):"; echo "$flaky"; echo "==> (the 'failed' count above includes those first attempts)"; } || true
exit "$rc"
