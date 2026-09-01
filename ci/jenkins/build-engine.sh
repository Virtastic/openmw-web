#!/usr/bin/env bash
# Build the WASM engine image on the local build server.
# Clean compile, ~13 min by design (Dockerfile deliberately has no ninja cache mount).
set -euo pipefail

SRC="${SRC:-/src}"
TAG="${TAG:-morrowind:test}"

# WASM64 (MEMORY64) is the only target: a wasm32 engine cannot hold a Tamriel Rebuilt load
# order and the client is built for MEMORY64. OMW_WASM64 survives only as a guard.
if [ "${OMW_WASM64:-1}" != "1" ]; then
  echo "FATAL: wasm32 is no longer a target. The engine is wasm64 (MEMORY64) only." >&2
  exit 1
fi
DEPS_DIR=deps/wasm64; BUILDER_IMAGE=openmw-builder64:1

cd "$SRC"

# The build fails deep and confusingly if these gitignored inputs are missing, so check up front.
[ -d "$DEPS_DIR" ]          || { echo "FATAL: $DEPS_DIR missing - restage from build-artifacts"; exit 1; }
[ -n "$(ls -A fsroot/gamedata 2>/dev/null)" ] || { echo "FATAL: fsroot/gamedata is empty"; exit 1; }
[ -f fsroot/icudt68l.dat ]  || { echo "FATAL: fsroot/icudt68l.dat missing"; exit 1; }
docker image inspect "$BUILDER_IMAGE" >/dev/null 2>&1 \
  || { echo "FATAL: $BUILDER_IMAGE not built. See ci/jenkins/README.md"; exit 1; }

echo "==> building $TAG ($DEPS_DIR, $BUILDER_IMAGE) from $(cat .source-commit 2>/dev/null || echo 'unknown commit')"
# --network=host: CMake FetchContent (recastnavigation) needs egress; the default bridge has none.
# No build-arg: the Dockerfile hardcodes the wasm64 builder now.
DOCKER_BUILDKIT=1 docker build --network=host -t "$TAG" -f Dockerfile .

echo "==> built $TAG"
docker image inspect "$TAG" --format '    size: {{.Size}} bytes  created: {{.Created}}'
